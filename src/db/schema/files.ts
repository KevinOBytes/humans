import { sql } from "drizzle-orm";
import {
  bigint,
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

import { sensitivityEnum } from "./enums";
import { jobs } from "./operations";
import { workspacePrincipals } from "./principals";
import { workspaces } from "./workspaces";

const domainTimestamp = (name: string) =>
  timestamp(name, { mode: "date", precision: 3, withTimezone: true });

export const files = pgTable(
  "files",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    storageProvider: text("storage_provider").notNull(),
    storageBucket: text("storage_bucket").notNull(),
    storageKey: text("storage_key").notNull(),
    originalName: text("original_name").notNull(),
    mediaType: text("media_type"),
    detectedType: text("detected_type"),
    byteSize: bigint("byte_size", { mode: "number" }).notNull(),
    checksum: text("checksum").notNull(),
    encryptionMetadata: jsonb("encryption_metadata").default({}).notNull(),
    quarantineState: text("quarantine_state").default("pending").notNull(),
    scanState: text("scan_state").default("pending").notNull(),
    ocrState: text("ocr_state").default("pending").notNull(),
    extractionState: text("extraction_state").default("pending").notNull(),
    sensitivity: sensitivityEnum("sensitivity").default("internal").notNull(),
    uploadedBy: text("uploaded_by").notNull(),
    version: integer("version").default(1).notNull(),
    createdAt: domainTimestamp("created_at").defaultNow().notNull(),
    createdBy: text("created_by").notNull(),
    updatedAt: domainTimestamp("updated_at").defaultNow().notNull(),
    updatedBy: text("updated_by").notNull(),
    deletedAt: domainTimestamp("deleted_at"),
    deletedBy: text("deleted_by"),
  },
  (table) => [
    unique("files_workspace_id_unique").on(table.workspaceId, table.id),
    unique("files_workspace_storage_key_unique").on(
      table.workspaceId,
      table.storageProvider,
      table.storageBucket,
      table.storageKey,
    ),
    index("files_workspace_checksum_idx").on(table.workspaceId, table.checksum),
    index("files_workspace_quarantine_idx").on(
      table.workspaceId,
      table.quarantineState,
      table.scanState,
    ),
    foreignKey({
      name: "files_workspace_uploader_fk",
      columns: [table.workspaceId, table.uploadedBy],
      foreignColumns: [
        workspacePrincipals.workspaceId,
        workspacePrincipals.userId,
      ],
    }).onDelete("restrict"),
    check("files_byte_size_check", sql`${table.byteSize} >= 0`),
    check("files_version_check", sql`${table.version} > 0`),
  ],
);

export const fileVariants = pgTable(
  "file_variants",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    parentFileId: uuid("parent_file_id").notNull(),
    kind: text("kind").notNull(),
    storageProvider: text("storage_provider").notNull(),
    storageBucket: text("storage_bucket").notNull(),
    storageKey: text("storage_key").notNull(),
    mediaType: text("media_type"),
    byteSize: bigint("byte_size", { mode: "number" }),
    checksum: text("checksum").notNull(),
    generatorVersion: text("generator_version"),
    createdAt: domainTimestamp("created_at").defaultNow().notNull(),
    createdBy: text("created_by").notNull(),
  },
  (table) => [
    unique("file_variants_workspace_id_unique").on(table.workspaceId, table.id),
    unique("file_variants_workspace_kind_unique").on(
      table.workspaceId,
      table.parentFileId,
      table.kind,
    ),
    foreignKey({
      name: "file_variants_workspace_parent_file_fk",
      columns: [table.workspaceId, table.parentFileId],
      foreignColumns: [files.workspaceId, files.id],
    }).onDelete("cascade"),
    check(
      "file_variants_byte_size_check",
      sql`${table.byteSize} IS NULL OR ${table.byteSize} >= 0`,
    ),
  ],
);

export const uploadSessions = pgTable(
  "upload_sessions",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    actorId: text("actor_id").notNull(),
    intendedPurpose: text("intended_purpose").notNull(),
    originalName: text("original_name").notNull(),
    sensitivity: sensitivityEnum("sensitivity").default("internal").notNull(),
    maxBytes: bigint("max_bytes", { mode: "number" }).notNull(),
    expectedChecksum: text("expected_checksum"),
    expectedMediaType: text("expected_media_type"),
    objectKey: text("object_key").notNull(),
    state: text("state").default("pending").notNull(),
    expiresAt: domainTimestamp("expires_at").notNull(),
    completedAt: domainTimestamp("completed_at"),
    fileId: uuid("file_id"),
    failureCode: text("failure_code"),
    cleanupCompletedAt: domainTimestamp("cleanup_completed_at"),
    createdAt: domainTimestamp("created_at").defaultNow().notNull(),
    createdBy: text("created_by").notNull(),
    updatedAt: domainTimestamp("updated_at").defaultNow().notNull(),
    updatedBy: text("updated_by").notNull(),
  },
  (table) => [
    unique("upload_sessions_workspace_id_unique").on(
      table.workspaceId,
      table.id,
    ),
    unique("upload_sessions_workspace_object_key_unique").on(
      table.workspaceId,
      table.objectKey,
    ),
    foreignKey({
      name: "upload_sessions_workspace_file_fk",
      columns: [table.workspaceId, table.fileId],
      foreignColumns: [files.workspaceId, files.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "upload_sessions_workspace_actor_fk",
      columns: [table.workspaceId, table.actorId],
      foreignColumns: [
        workspacePrincipals.workspaceId,
        workspacePrincipals.userId,
      ],
    }).onDelete("restrict"),
    check("upload_sessions_max_bytes_check", sql`${table.maxBytes} > 0`),
    check(
      "upload_sessions_original_name_bytes_check",
      sql`octet_length(${table.originalName}) BETWEEN 1 AND 255`,
    ),
    index("upload_sessions_cleanup_due_idx").on(
      table.state,
      table.expiresAt,
      table.id,
    ),
  ],
);

export const imports = pgTable(
  "imports",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    fileId: uuid("file_id").notNull(),
    format: text("format").notNull(),
    state: text("state").default("pending").notNull(),
    mapping: jsonb("mapping").default({}).notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    executionJobId: uuid("execution_job_id"),
    stagingGeneration: integer("staging_generation").default(0).notNull(),
    stagingOwner: uuid("staging_owner"),
    stagingLeaseExpiresAt: domainTimestamp("staging_lease_expires_at"),
    totalRows: integer("total_rows").default(0).notNull(),
    acceptedRows: integer("accepted_rows").default(0).notNull(),
    rejectedRows: integer("rejected_rows").default(0).notNull(),
    startedAt: domainTimestamp("started_at"),
    completedAt: domainTimestamp("completed_at"),
    version: integer("version").default(1).notNull(),
    createdAt: domainTimestamp("created_at").defaultNow().notNull(),
    createdBy: text("created_by").notNull(),
    updatedAt: domainTimestamp("updated_at").defaultNow().notNull(),
    updatedBy: text("updated_by").notNull(),
  },
  (table) => [
    unique("imports_workspace_id_unique").on(table.workspaceId, table.id),
    unique("imports_workspace_idempotency_unique").on(
      table.workspaceId,
      table.idempotencyKey,
    ),
    unique("imports_workspace_execution_job_unique").on(
      table.workspaceId,
      table.executionJobId,
    ),
    foreignKey({
      name: "imports_workspace_file_fk",
      columns: [table.workspaceId, table.fileId],
      foreignColumns: [files.workspaceId, files.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "imports_workspace_actor_fk",
      columns: [table.workspaceId, table.createdBy],
      foreignColumns: [
        workspacePrincipals.workspaceId,
        workspacePrincipals.userId,
      ],
    }).onDelete("restrict"),
    foreignKey({
      name: "imports_workspace_execution_job_fk",
      columns: [table.workspaceId, table.executionJobId],
      foreignColumns: [jobs.workspaceId, jobs.id],
    }).onDelete("restrict"),
    check(
      "imports_totals_check",
      sql`${table.totalRows} >= 0 AND ${table.acceptedRows} >= 0 AND ${table.rejectedRows} >= 0 AND ${table.acceptedRows} + ${table.rejectedRows} <= ${table.totalRows}`,
    ),
    check("imports_version_check", sql`${table.version} > 0`),
    check(
      "imports_staging_generation_check",
      sql`${table.stagingGeneration} >= 0`,
    ),
    check(
      "imports_staging_lease_check",
      sql`(${table.stagingOwner} IS NULL AND ${table.stagingLeaseExpiresAt} IS NULL) OR (${table.stagingOwner} IS NOT NULL AND ${table.stagingLeaseExpiresAt} IS NOT NULL)`,
    ),
  ],
);

export const importMappings = pgTable(
  "import_mappings",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    format: text("format").notNull(),
    columnMapping: jsonb("column_mapping").default({}).notNull(),
    validationConfig: jsonb("validation_config").default({}).notNull(),
    version: integer("version").default(1).notNull(),
    createdAt: domainTimestamp("created_at").defaultNow().notNull(),
    createdBy: text("created_by").notNull(),
    updatedAt: domainTimestamp("updated_at").defaultNow().notNull(),
    updatedBy: text("updated_by").notNull(),
    deletedAt: domainTimestamp("deleted_at"),
    deletedBy: text("deleted_by"),
  },
  (table) => [
    unique("import_mappings_workspace_id_unique").on(
      table.workspaceId,
      table.id,
    ),
    unique("import_mappings_workspace_name_unique").on(
      table.workspaceId,
      table.name,
    ),
    check("import_mappings_version_check", sql`${table.version} > 0`),
  ],
);

export const importRows = pgTable(
  "import_rows",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    importId: uuid("import_id").notNull(),
    stagingGeneration: integer("staging_generation").default(0).notNull(),
    rowNumber: integer("row_number").notNull(),
    sourceHash: text("source_hash").notNull(),
    normalizedPayload: jsonb("normalized_payload").default({}).notNull(),
    resultReferences: jsonb("result_references").default([]).notNull(),
    validationErrors: jsonb("validation_errors").default([]).notNull(),
    state: text("state").default("pending").notNull(),
    createdAt: domainTimestamp("created_at").defaultNow().notNull(),
    createdBy: text("created_by").notNull(),
    updatedAt: domainTimestamp("updated_at").defaultNow().notNull(),
    updatedBy: text("updated_by").notNull(),
  },
  (table) => [
    unique("import_rows_workspace_id_unique").on(table.workspaceId, table.id),
    unique("import_rows_workspace_row_unique").on(
      table.workspaceId,
      table.importId,
      table.stagingGeneration,
      table.rowNumber,
    ),
    foreignKey({
      name: "import_rows_workspace_import_fk",
      columns: [table.workspaceId, table.importId],
      foreignColumns: [imports.workspaceId, imports.id],
    }).onDelete("cascade"),
    check("import_rows_row_number_check", sql`${table.rowNumber} > 0`),
    check(
      "import_rows_staging_generation_check",
      sql`${table.stagingGeneration} >= 0`,
    ),
  ],
);

export const extractionRuns = pgTable(
  "extraction_runs",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    fileId: uuid("file_id").notNull(),
    extractor: text("extractor").notNull(),
    extractorVersion: text("extractor_version").notNull(),
    configuration: jsonb("configuration").default({}).notNull(),
    state: text("state").default("pending").notNull(),
    structuredOutput: jsonb("structured_output"),
    errorSummary: jsonb("error_summary"),
    startedAt: domainTimestamp("started_at"),
    completedAt: domainTimestamp("completed_at"),
    createdAt: domainTimestamp("created_at").defaultNow().notNull(),
    createdBy: text("created_by").notNull(),
  },
  (table) => [
    unique("extraction_runs_workspace_id_unique").on(
      table.workspaceId,
      table.id,
    ),
    index("extraction_runs_workspace_file_idx").on(
      table.workspaceId,
      table.fileId,
      table.createdAt,
    ),
    foreignKey({
      name: "extraction_runs_workspace_file_fk",
      columns: [table.workspaceId, table.fileId],
      foreignColumns: [files.workspaceId, files.id],
    }).onDelete("cascade"),
  ],
);
