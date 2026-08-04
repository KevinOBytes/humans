// @vitest-environment node

import { getTableName } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { getTableConfig, PgDialect } from "drizzle-orm/pg-core";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as schema from "@/db/schema";
import { newId } from "@/db/id";
import { seedDatabase } from "@/db/seed";
import { assertTestDatabaseResetAllowed } from "../support/database-reset-guard";

const foreignKeyNames = (table: Parameters<typeof getTableConfig>[0]) =>
  getTableConfig(table).foreignKeys.map((foreignKey) => foreignKey.getName());

const constraintNames = (table: Parameters<typeof getTableConfig>[0]) => {
  const config = getTableConfig(table);
  return [
    ...config.checks.map((constraint) => constraint.name),
    ...config.uniqueConstraints.map((constraint) => constraint.name),
    ...config.foreignKeys.map((foreignKey) => foreignKey.getName()),
  ];
};

const foreignKeyContract = (
  table: Parameters<typeof getTableConfig>[0],
  name: string,
) => {
  const foreignKey = getTableConfig(table).foreignKeys.find(
    (candidate) => candidate.getName() === name,
  );
  if (!foreignKey) throw new Error(`Missing foreign key ${name}`);
  const reference = foreignKey.reference();
  return {
    columns: reference.columns.map((column) => column.name),
    foreignColumns: reference.foreignColumns.map((column) => column.name),
    foreignTable: getTableName(reference.foreignTable),
  };
};

const onDeleteAction = (
  table: Parameters<typeof getTableConfig>[0],
  constraintName: string,
) =>
  getTableConfig(table).foreignKeys.find(
    (foreignKey) => foreignKey.getName() === constraintName,
  )?.onDelete;

describe("remaining workspace constraints", () => {
  it.each([
    ["facts", "facts_workspace_place_fk"],
    ["facts", "facts_workspace_file_fk"],
    ["people", "people_workspace_primary_photo_fk"],
    ["personEvents", "person_events_workspace_place_fk"],
    ["externalRecords", "external_records_workspace_import_fk"],
  ] as const)("closes %s with %s", (tableName, constraintName) => {
    expect(
      foreignKeyNames(
        schema[tableName] as Parameters<typeof getTableConfig>[0],
      ),
    ).toContain(constraintName);
  });

  it.each([
    [schema.evidenceItems, "evidence_items_workspace_file_fk", "restrict"],
    [schema.fileVariants, "file_variants_workspace_parent_file_fk", "cascade"],
    [schema.relationships, "relationships_workspace_type_fk", "restrict"],
    [schema.aiMessages, "ai_messages_workspace_thread_fk", "cascade"],
    [
      schema.webhookDeliveries,
      "webhook_deliveries_workspace_webhook_fk",
      "cascade",
    ],
    [schema.queryRuns, "query_runs_workspace_saved_query_fk", "restrict"],
    [schema.graphSnapshots, "graph_snapshots_workspace_view_fk", "restrict"],
    [schema.aiRuns, "ai_runs_workspace_input_message_fk", "restrict"],
    [schema.notes, "notes_workspace_person_fk", "cascade"],
    [schema.notes, "notes_workspace_fact_fk", "cascade"],
    [schema.notes, "notes_workspace_relationship_fk", "cascade"],
    [schema.notes, "notes_workspace_evidence_fk", "cascade"],
  ] as const)("uses %s delete action on %s", (table, constraint, action) => {
    expect(onDeleteAction(table, constraint)).toBe(action);
  });

  it("binds an import execution job to the same workspace without cascading deletion", () => {
    const executionJobConstraint = getTableConfig(
      schema.imports,
    ).uniqueConstraints.find(
      (candidate) =>
        candidate.name === "imports_workspace_execution_job_unique",
    );
    expect(
      foreignKeyContract(schema.imports, "imports_workspace_execution_job_fk"),
    ).toEqual({
      columns: ["workspace_id", "execution_job_id"],
      foreignColumns: ["workspace_id", "id"],
      foreignTable: "jobs",
    });
    expect(
      onDeleteAction(schema.imports, "imports_workspace_execution_job_fk"),
    ).toBe("restrict");
    expect(schema.imports.executionJobId.notNull).toBe(false);
    expect(
      executionJobConstraint?.columns.map((column) => column.name),
    ).toEqual(["workspace_id", "execution_job_id"]);
  });

  it("keeps claim generation distinct from the retry budget", () => {
    const claimGenerationCheck = getTableConfig(schema.jobs).checks.find(
      (constraint) => constraint.name === "jobs_claim_generation_check",
    );
    expect(claimGenerationCheck).toBeDefined();
    expect(schema.jobs.claimGeneration.notNull).toBe(true);
    expect(schema.jobs.claimGeneration.default).toBe(0);
    expect(schema.jobs.attemptCount.default).toBe(0);
    expect(
      new PgDialect().sqlToQuery(claimGenerationCheck!.value).sql,
    ).toContain(">= 0");
  });

  it.each([
    "consent_records_workspace_evidence_fk",
    "deletion_requests_workspace_export_fk",
  ])("closes cyclic deferred reference %s in SQL", (constraintName) => {
    const migration = readdirSync("drizzle")
      .filter((file) => file.endsWith(".sql"))
      .sort()
      .map((file) => readFileSync(`drizzle/${file}`, "utf8"))
      .join("\n");

    expect(migration).toContain(`CONSTRAINT "${constraintName}"`);
  });

  it.each([
    ["personContactPoints", "person_contact_points_workspace_person_fk"],
    ["personContactPoints", "person_contact_points_workspace_contact_fk"],
    ["personAddresses", "person_addresses_workspace_person_fk"],
    ["relationships", "relationships_workspace_source_person_fk"],
    ["relationships", "relationships_workspace_target_person_fk"],
    ["factEvidence", "fact_evidence_workspace_fact_fk"],
    ["factEvidence", "fact_evidence_workspace_evidence_fk"],
    ["relationshipEvidence", "relationship_evidence_workspace_relationship_fk"],
    ["relationshipEvidence", "relationship_evidence_workspace_evidence_fk"],
    ["evidenceItems", "evidence_items_workspace_source_fk"],
    ["evidenceItems", "evidence_items_workspace_file_fk"],
    ["fileVariants", "file_variants_workspace_parent_file_fk"],
    ["importRows", "import_rows_workspace_import_fk"],
    ["graphViewNodes", "graph_view_nodes_workspace_view_fk"],
    ["graphViewNodes", "graph_view_nodes_workspace_person_fk"],
    ["analysisResults", "analysis_results_workspace_run_fk"],
    ["aiMessages", "ai_messages_workspace_thread_fk"],
    ["aiCitations", "ai_citations_workspace_run_fk"],
    ["webhookDeliveries", "webhook_deliveries_workspace_webhook_fk"],
  ] as const)("defines %s constraint %s", (tableName, constraintName) => {
    const table = schema[tableName as keyof typeof schema];
    expect(table).toBeDefined();
    expect(
      foreignKeyNames(table as Parameters<typeof getTableConfig>[0]),
    ).toContain(constraintName);
  });

  it.each([
    [schema.workspacePrincipals, "workspace_principals_workspace_user_unique"],
    [
      schema.workspacePrincipals,
      "workspace_principals_workspace_api_key_unique",
    ],
    [schema.apiKeys, "api_keys_workspace_id_unique"],
    [schema.apiKeys, "api_keys_workspace_organization_fk"],
    [schema.savedQueries, "saved_queries_workspace_owner_principal_fk"],
    [schema.queryRuns, "query_runs_workspace_actor_principal_fk"],
    [schema.files, "files_workspace_uploader_fk"],
    [schema.uploadSessions, "upload_sessions_workspace_actor_fk"],
    [schema.imports, "imports_workspace_actor_fk"],
    [schema.graphViews, "graph_views_workspace_owner_fk"],
    [schema.aiThreads, "ai_threads_workspace_owner_fk"],
    [schema.aiMessages, "ai_messages_workspace_actor_fk"],
    [schema.aiRuns, "ai_runs_workspace_actor_fk"],
    [schema.jobs, "jobs_workspace_actor_fk"],
    [schema.jobs, "jobs_workspace_updater_fk"],
    [schema.auditEvents, "audit_events_workspace_actor_fk"],
    [schema.auditEvents, "audit_events_workspace_api_key_fk"],
    [schema.idempotencyKeys, "idempotency_keys_workspace_actor_fk"],
    [schema.webhooks, "webhooks_workspace_creator_fk"],
  ] as const)("enforces tenant principal constraint %s", (table, name) => {
    expect(constraintNames(table)).toContain(name);
  });

  it("binds durable user attribution to immutable workspace principals", () => {
    expect(
      foreignKeyContract(schema.auditEvents, "audit_events_workspace_actor_fk"),
    ).toEqual({
      columns: ["workspace_id", "actor_user_id"],
      foreignColumns: ["workspace_id", "user_id"],
      foreignTable: "workspace_principals",
    });

    for (const [table, constraint] of [
      [schema.savedQueries, "saved_queries_workspace_owner_principal_fk"],
      [schema.queryRuns, "query_runs_workspace_actor_principal_fk"],
      [schema.files, "files_workspace_uploader_fk"],
      [schema.uploadSessions, "upload_sessions_workspace_actor_fk"],
      [schema.imports, "imports_workspace_actor_fk"],
      [schema.graphViews, "graph_views_workspace_owner_fk"],
      [schema.aiThreads, "ai_threads_workspace_owner_fk"],
      [schema.aiMessages, "ai_messages_workspace_actor_fk"],
      [schema.aiRuns, "ai_runs_workspace_actor_fk"],
      [schema.jobs, "jobs_workspace_actor_fk"],
      [schema.jobs, "jobs_workspace_updater_fk"],
      [schema.idempotencyKeys, "idempotency_keys_workspace_actor_fk"],
      [schema.webhooks, "webhooks_workspace_creator_fk"],
    ] as const) {
      expect(foreignKeyContract(table, constraint).foreignTable).toBe(
        "workspace_principals",
      );
    }
  });

  it("allows system jobs while constraining any attributed users", () => {
    expect(schema.jobs.createdBy.notNull).toBe(false);
    expect(schema.jobs.updatedBy.notNull).toBe(false);
  });

  it("binds organization API keys and their audit snapshots to one workspace", () => {
    expect(
      foreignKeyContract(schema.apiKeys, "api_keys_workspace_organization_fk"),
    ).toEqual({
      columns: ["workspace_id", "reference_id"],
      foreignColumns: ["id", "organization_id"],
      foreignTable: "workspaces",
    });
    expect(
      foreignKeyContract(
        schema.auditEvents,
        "audit_events_workspace_api_key_fk",
      ),
    ).toEqual({
      columns: ["workspace_id", "api_key_id"],
      foreignColumns: ["workspace_id", "api_key_id"],
      foreignTable: "workspace_principals",
    });
  });

  it("keeps ephemeral auth validation in write-time triggers, not deletion-blocking FKs", () => {
    const constraints = foreignKeyNames(schema.auditEvents);
    expect(constraints).not.toContain("audit_events_actor_session_fk");

    const migration = readFileSync("drizzle/0003_task5_corrective.sql", "utf8");
    expect(migration).toContain("validate_workspace_principal");
    expect(migration).toContain("validate_audit_event_actor");
    expect(migration).toContain("validate_workspace_user_attribution");
  });

  it("keeps AI run inputs and citations within one thread", () => {
    expect(
      foreignKeyContract(schema.aiRuns, "ai_runs_workspace_input_message_fk"),
    ).toEqual({
      columns: ["workspace_id", "thread_id", "message_id"],
      foreignColumns: ["workspace_id", "thread_id", "id"],
      foreignTable: "ai_messages",
    });
    expect(
      foreignKeyContract(schema.aiCitations, "ai_citations_workspace_run_fk"),
    ).toEqual({
      columns: ["workspace_id", "thread_id", "ai_run_id"],
      foreignColumns: ["workspace_id", "thread_id", "id"],
      foreignTable: "ai_runs",
    });
    expect(
      foreignKeyContract(
        schema.aiCitations,
        "ai_citations_workspace_message_fk",
      ),
    ).toEqual({
      columns: ["workspace_id", "thread_id", "message_id"],
      foreignColumns: ["workspace_id", "thread_id", "id"],
      foreignTable: "ai_messages",
    });
    expect(schema.aiCitations.messageId.notNull).toBe(false);
    expect(schema.aiCitations.legacyMessageId.notNull).toBe(false);
  });

  it("defines a PostgreSQL GIN index for workspace-filtered full-text search", () => {
    const ginIndex = getTableConfig(schema.searchDocuments).indexes.find(
      (candidate) =>
        candidate.config.name === "search_documents_search_vector_gin",
    );
    expect(ginIndex?.config.method).toBe("gin");
    expect(
      ginIndex?.config.columns.map((column) =>
        "name" in column ? column.name : undefined,
      ),
    ).toEqual(["search_vector"]);
  });

  it("preserves the originally committed Task 5 migration byte-for-byte", () => {
    expect(
      createHash("sha256")
        .update(readFileSync("drizzle/0002_core.sql"))
        .digest("hex"),
    ).toBe("a906a45fae7217f3f5bc838278bc866e3e6f8b6099a0965b14b47e2191e75d2f");

    const corrective = readFileSync(
      "drizzle/0003_task5_corrective.sql",
      "utf8",
    );
    expect(corrective).not.toContain(
      'ADD CONSTRAINT "consent_records_workspace_evidence_fk"',
    );
    expect(corrective).not.toContain(
      'ADD CONSTRAINT "deletion_requests_workspace_export_fk"',
    );
  });

  it("models privacy references in Drizzle metadata", () => {
    expect(constraintNames(schema.consentRecords)).toContain(
      "consent_records_workspace_evidence_fk",
    );
    expect(constraintNames(schema.deletionRequests)).toContain(
      "deletion_requests_workspace_export_fk",
    );
  });

  it("allows at most one note subject", () => {
    const config = getTableConfig(schema.notes);
    const subjectCheck = config.checks.find(
      (check) => check.name === "notes_subject_check",
    );
    if (!subjectCheck) throw new Error("Missing notes_subject_check");

    expect([
      schema.notes.personId.notNull,
      schema.notes.factId.notNull,
      schema.notes.relationshipId.notNull,
      schema.notes.evidenceItemId.notNull,
    ]).toEqual([false, false, false, false]);
    expect(new PgDialect().sqlToQuery(subjectCheck.value).sql).toContain(
      "num_nonnulls",
    );
  });
});

const databaseUrl = process.env.TEST_DATABASE_URL;
const resetAllowed = process.env.ALLOW_TEST_DATABASE_RESET;
const liveDescribe = databaseUrl || resetAllowed ? describe : describe.skip;
const liveClient = databaseUrl
  ? postgres(databaseUrl, { max: 1, onnotice: () => undefined, prepare: false })
  : undefined;

const workspaceA = "01900000-0000-7000-8000-000000000001";
const workspaceB = "01900000-0000-7000-8000-000000000002";
const personA = "01900000-0000-7000-8000-000000000011";
const personB = "01900000-0000-7000-8000-000000000012";
const actorA = "seed-user-alpha";
const actorB = "seed-user-beta";
const principalA = "01900000-0000-7000-8000-000000000003";
const principalB = "01900000-0000-7000-8000-000000000004";
const ids = {
  aiMessageA1: "01900000-0000-7000-8000-000000000031",
  aiMessageA2: "01900000-0000-7000-8000-000000000032",
  aiRunA1: "01900000-0000-7000-8000-000000000033",
  aiThreadA1: "01900000-0000-7000-8000-000000000034",
  aiThreadA2: "01900000-0000-7000-8000-000000000035",
  aiThreadB: "01900000-0000-7000-8000-000000000021",
  apiKeyB: "seed-api-key-beta",
  evidenceB: "01900000-0000-7000-8000-000000000022",
  factA: "01900000-0000-7000-8000-00000000002b",
  factDefinitionFileA: "01900000-0000-7000-8000-00000000002c",
  factDefinitionPlaceA: "01900000-0000-7000-8000-00000000002d",
  factDefinitionTextA: "01900000-0000-7000-8000-00000000002e",
  fileB: "01900000-0000-7000-8000-000000000023",
  fileA: "01900000-0000-7000-8000-000000000036",
  graphViewB: "01900000-0000-7000-8000-000000000024",
  importB: "01900000-0000-7000-8000-000000000025",
  placeB: "01900000-0000-7000-8000-000000000026",
  relationshipTypeA: "01900000-0000-7000-8000-000000000027",
  savedQueryB: "01900000-0000-7000-8000-000000000028",
  sourceB: "01900000-0000-7000-8000-000000000029",
  sessionA: "seed-session-alpha",
  sessionB: "seed-session-beta",
  webhookB: "01900000-0000-7000-8000-00000000002a",
} as const;

const db = () => {
  if (!liveClient) throw new Error("TEST_DATABASE_URL is required");
  return liveClient;
};

const expectForeignKeyViolation = async (operation: Promise<unknown>) => {
  await expect(operation).rejects.toMatchObject({ code: "23503" });
};

const expectPrincipalPolicyViolation = async (operation: Promise<unknown>) => {
  await expect(operation).rejects.toMatchObject({ code: "23514" });
};

liveDescribe("workspace constraints on PostgreSQL 18", () => {
  beforeAll(async () => {
    const [database] = await db()<[{ database: string }]>`
      SELECT current_database() AS database
    `;
    assertTestDatabaseResetAllowed({
      allowReset: resetAllowed,
      currentDatabase: database.database,
      databaseUrl,
    });

    await db().unsafe("DROP SCHEMA IF EXISTS drizzle CASCADE");
    await db().unsafe("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    await migrate(drizzle(db()), { migrationsFolder: "drizzle" });
    await seedDatabase(databaseUrl!);
    await seedDatabase(databaseUrl!);

    await db()`INSERT INTO places (id, workspace_id, name, kind, created_by, updated_by) VALUES (${ids.placeB}, ${workspaceB}, 'London', 'city', 'seed-user-beta', 'seed-user-beta')`;
    await db()`INSERT INTO files (id, workspace_id, storage_provider, storage_bucket, storage_key, original_name, byte_size, checksum, uploaded_by, created_by, updated_by) VALUES (${ids.fileB}, ${workspaceB}, 's3', 'test', 'beta/file', 'file.txt', 1, 'sha256:beta', 'seed-user-beta', 'seed-user-beta', 'seed-user-beta')`;
    await db()`INSERT INTO files (id, workspace_id, storage_provider, storage_bucket, storage_key, original_name, byte_size, checksum, uploaded_by, created_by, updated_by) VALUES (${ids.fileA}, ${workspaceA}, 's3', 'test', 'alpha/file', 'file.txt', 1, 'sha256:alpha', ${actorA}, ${actorA}, ${actorA})`;
    await db()`INSERT INTO sources (id, workspace_id, kind, title, created_by, updated_by) VALUES (${ids.sourceB}, ${workspaceB}, 'document', 'Beta source', 'seed-user-beta', 'seed-user-beta')`;
    await db()`INSERT INTO evidence_items (id, workspace_id, source_id, file_id, checksum, created_by, updated_by) VALUES (${ids.evidenceB}, ${workspaceB}, ${ids.sourceB}, ${ids.fileB}, 'sha256:evidence', 'seed-user-beta', 'seed-user-beta')`;
    await db()`INSERT INTO imports (id, workspace_id, file_id, format, idempotency_key, created_by, updated_by) VALUES (${ids.importB}, ${workspaceB}, ${ids.fileB}, 'csv', 'beta-import', 'seed-user-beta', 'seed-user-beta')`;
    await db()`INSERT INTO relationship_types (id, workspace_id, key, forward_label, inverse_label, created_by, updated_by) VALUES (${ids.relationshipTypeA}, ${workspaceA}, 'knows', 'knows', 'known by', ${actorA}, ${actorA})`;
    await db()`INSERT INTO fact_definitions (id, workspace_id, namespace, field_key, label, allowed_value_type, created_by, updated_by) VALUES (${ids.factDefinitionTextA}, ${workspaceA}, 'seed', 'name', 'Name', 'text', ${actorA}, ${actorA}), (${ids.factDefinitionPlaceA}, ${workspaceA}, 'seed', 'place', 'Place', 'place_reference', ${actorA}, ${actorA}), (${ids.factDefinitionFileA}, ${workspaceA}, 'seed', 'file', 'File', 'file_reference', ${actorA}, ${actorA})`;
    await db()`INSERT INTO facts (id, workspace_id, person_id, fact_definition_id, namespace, field_key, label, value_type, value_text, created_by, updated_by) VALUES (${ids.factA}, ${workspaceA}, ${personA}, ${ids.factDefinitionTextA}, 'seed', 'name', 'Name', 'text', 'Ada Lovelace', ${actorA}, ${actorA})`;
    await db()`
      INSERT INTO saved_queries (
        id,
        workspace_id,
        owner_principal_id,
        name,
        query_ast,
        query_hash,
        created_by,
        updated_by
      )
      SELECT
        ${ids.savedQueryB},
        ${workspaceB},
        id,
        'Beta query',
        '{"schema":"humans.search-query","version":1,"match":{"type":"text","query":"beta"},"kinds":["PERSON"],"filters":{},"pageSize":25}'::jsonb,
        ${"0".repeat(64)},
        id,
        id
      FROM workspace_principals
      WHERE workspace_id = ${workspaceB} AND user_id = ${actorB}
    `;
    await db()`INSERT INTO graph_views (id, workspace_id, owner_id, name, created_by, updated_by) VALUES (${ids.graphViewB}, ${workspaceB}, 'seed-user-beta', 'Beta view', 'seed-user-beta', 'seed-user-beta')`;
    await db()`INSERT INTO ai_threads (id, workspace_id, owner_id, title, created_by, updated_by) VALUES (${ids.aiThreadB}, ${workspaceB}, 'seed-user-beta', 'Beta thread', 'seed-user-beta', 'seed-user-beta')`;
    await db()`INSERT INTO ai_threads (id, workspace_id, owner_id, title, created_by, updated_by) VALUES (${ids.aiThreadA1}, ${workspaceA}, ${actorA}, 'Alpha thread one', ${actorA}, ${actorA}), (${ids.aiThreadA2}, ${workspaceA}, ${actorA}, 'Alpha thread two', ${actorA}, ${actorA})`;
    await db()`INSERT INTO ai_messages (id, workspace_id, thread_id, role, encrypted_content, content_hash, created_by, updated_by) VALUES (${ids.aiMessageA1}, ${workspaceA}, ${ids.aiThreadA1}, 'user', 'encrypted:one', 'sha256:one', ${actorA}, ${actorA}), (${ids.aiMessageA2}, ${workspaceA}, ${ids.aiThreadA2}, 'assistant', 'encrypted:two', 'sha256:two', ${actorA}, ${actorA})`;
    await db()`INSERT INTO sessions (id, expires_at, token, user_id) VALUES (${ids.sessionA}, now() + interval '1 day', 'seed-session-token-alpha', ${actorA}), (${ids.sessionB}, now() + interval '1 day', 'seed-session-token-beta', ${actorB})`;
    await db()`INSERT INTO api_keys (id, config_id, reference_id, key, created_at, updated_at, workspace_id) VALUES (${ids.apiKeyB}, 'default', 'seed-organization-beta', 'seed-api-key-value-beta', now(), now(), ${workspaceB})`;
    await db()`INSERT INTO webhooks (id, workspace_id, url, encrypted_secret, secret_fingerprint, subscribed_events, created_by, updated_by) VALUES (${ids.webhookB}, ${workspaceB}, 'https://example.test/hook', 'encrypted:test', 'sha256:test', ARRAY['person.updated'], 'seed-user-beta', 'seed-user-beta')`;
  }, 30_000);

  afterAll(async () => {
    await liveClient?.end();
  });

  it("seeds two isolated organizations with the same person name idempotently", async () => {
    const [counts] = await db()<
      [{ organizations: number; people: number; workspaces: number }]
    >`
      SELECT
        (SELECT count(*)::int FROM organizations WHERE id LIKE 'seed-organization-%') AS organizations,
        (SELECT count(*)::int FROM workspaces WHERE id IN (${workspaceA}, ${workspaceB})) AS workspaces,
        (SELECT count(*)::int FROM people WHERE display_name = 'Ada Lovelace') AS people
    `;
    expect(counts).toEqual({ organizations: 2, people: 2, workspaces: 2 });
  });

  it("derives member and API-key workspaces from their trusted organization references", async () => {
    const userId = `derived-user-${newId()}`;
    const memberId = `derived-member-${newId()}`;
    const apiKeyId = `derived-key-${newId()}`;
    await db()`INSERT INTO users (id, name, email, email_verified, created_at, updated_at) VALUES (${userId}, 'Derived User', ${`${newId()}@example.test`}, true, now(), now())`;
    await db()`INSERT INTO members (id, organization_id, user_id, role, created_at, workspace_id) VALUES (${memberId}, 'seed-organization-alpha', ${userId}, 'viewer', now(), ${workspaceB})`;
    await db()`INSERT INTO api_keys (id, config_id, reference_id, key, created_at, updated_at, workspace_id) VALUES (${apiKeyId}, 'organization', 'seed-organization-alpha', ${`hashed-${newId()}`}, now(), now(), ${workspaceB})`;

    const [derived] = await db()<
      [{ api_key_workspace_id: string; member_workspace_id: string }]
    >`
      SELECT
        (SELECT workspace_id::text FROM api_keys WHERE id = ${apiKeyId}) AS api_key_workspace_id,
        (SELECT workspace_id::text FROM members WHERE id = ${memberId}) AS member_workspace_id
    `;
    expect(derived).toEqual({
      api_key_workspace_id: workspaceA,
      member_workspace_id: workspaceA,
    });

    await db()`UPDATE members SET workspace_id = ${workspaceB} WHERE id = ${memberId}`;
    await db()`UPDATE api_keys SET workspace_id = ${workspaceB} WHERE id = ${apiKeyId}`;
    const [rederived] = await db()<
      [{ api_key_workspace_id: string; member_workspace_id: string }]
    >`
      SELECT
        (SELECT workspace_id::text FROM api_keys WHERE id = ${apiKeyId}) AS api_key_workspace_id,
        (SELECT workspace_id::text FROM members WHERE id = ${memberId}) AS member_workspace_id
    `;
    expect(rederived).toEqual({
      api_key_workspace_id: workspaceA,
      member_workspace_id: workspaceA,
    });
  });

  it("installs the full-text search index with PostgreSQL's GIN access method", async () => {
    const [index] = await db()<[{ indexdef: string }]>`
      SELECT indexdef
      FROM pg_indexes
      WHERE schemaname = 'public'
        AND tablename = 'search_documents'
        AND indexname = 'search_documents_search_vector_gin'
    `;
    expect(index.indexdef).toContain("USING gin (search_vector)");
  });

  it("validates live identities before creating immutable principal snapshots", async () => {
    await expectForeignKeyViolation(
      db()`INSERT INTO workspace_principals (id, workspace_id, principal_type, user_id, member_id_snapshot) VALUES (${newId()}, ${workspaceA}, 'user', ${actorB}, 'seed-member-beta')`,
    );
    await expect(
      db()`INSERT INTO workspace_principals (id, workspace_id, principal_type, user_id) VALUES (${newId()}, ${workspaceA}, 'legacy_user', 'new-legacy-user')`,
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      db()`UPDATE workspace_principals SET member_id_snapshot = 'changed' WHERE workspace_id = ${workspaceA} AND user_id = ${actorA}`,
    ).rejects.toMatchObject({ code: "55000" });

    const unreferencedPrincipalId = newId();
    await db()`INSERT INTO workspace_principals (id, workspace_id, principal_type, system_key) VALUES (${unreferencedPrincipalId}, ${workspaceA}, 'system', ${`test-system-${newId()}`})`;
    await expect(
      db()`DELETE FROM workspace_principals WHERE id = ${unreferencedPrincipalId}`,
    ).rejects.toMatchObject({ code: "55000" });
  });

  it("rejects cross-workspace location references", async () => {
    await expectForeignKeyViolation(
      db()`INSERT INTO addresses (id, workspace_id, place_id, line1, normalized_hash, created_by, updated_by) VALUES (${newId()}, ${workspaceA}, ${ids.placeB}, '1 Test St', ${"a5".repeat(32)}, ${actorA}, ${actorA})`,
    );
  });

  it("rejects cross-workspace relationship references", async () => {
    await expectForeignKeyViolation(
      db()`INSERT INTO relationships (id, workspace_id, source_person_id, target_person_id, relationship_type_id, created_by, updated_by) VALUES (${newId()}, ${workspaceA}, ${personA}, ${personB}, ${ids.relationshipTypeA}, ${actorA}, ${actorA})`,
    );
  });

  it("rejects self relationships unless the relationship type allows them", async () => {
    await expect(
      db()`INSERT INTO relationships (id, workspace_id, source_person_id, target_person_id, relationship_type_id, created_by, updated_by) VALUES (${newId()}, ${workspaceA}, ${personA}, ${personA}, ${ids.relationshipTypeA}, ${actorA}, ${actorA})`,
    ).rejects.toMatchObject({ code: "23514" });

    await db()`UPDATE relationship_types SET allows_self = true WHERE workspace_id = ${workspaceA} AND id = ${ids.relationshipTypeA}`;
    const selfRelationshipId = newId();
    await db()`INSERT INTO relationships (id, workspace_id, source_person_id, target_person_id, relationship_type_id, created_by, updated_by) VALUES (${selfRelationshipId}, ${workspaceA}, ${personA}, ${personA}, ${ids.relationshipTypeA}, ${actorA}, ${actorA})`;

    await expect(
      db()`UPDATE relationship_types SET allows_self = false WHERE workspace_id = ${workspaceA} AND id = ${ids.relationshipTypeA}`,
    ).rejects.toMatchObject({ code: "23514" });

    await db()`DELETE FROM relationships WHERE workspace_id = ${workspaceA} AND id = ${selfRelationshipId}`;
    await expect(
      db()`UPDATE relationship_types SET allows_self = false WHERE workspace_id = ${workspaceA} AND id = ${ids.relationshipTypeA}`,
    ).resolves.toBeDefined();
  });

  it("serializes a self-edge insert against disabling its relationship type", async () => {
    const writer = postgres(databaseUrl!, {
      max: 1,
      onnotice: () => undefined,
      prepare: false,
    });
    const policyWriter = postgres(databaseUrl!, {
      max: 1,
      onnotice: () => undefined,
      prepare: false,
    });
    const relationshipId = newId();
    let writerCommitted = false;

    await db()`DELETE FROM relationships WHERE workspace_id = ${workspaceA} AND relationship_type_id = ${ids.relationshipTypeA} AND source_person_id = target_person_id`;
    await db()`UPDATE relationship_types SET allows_self = true WHERE workspace_id = ${workspaceA} AND id = ${ids.relationshipTypeA}`;

    try {
      await writer.unsafe("BEGIN");
      await writer`
        INSERT INTO relationships (
          id,
          workspace_id,
          source_person_id,
          target_person_id,
          relationship_type_id,
          created_by,
          updated_by
        ) VALUES (
          ${relationshipId},
          ${workspaceA},
          ${personA},
          ${personA},
          ${ids.relationshipTypeA},
          ${actorA},
          ${actorA}
        )
      `;

      await policyWriter.unsafe("SET lock_timeout = '250ms'");
      await expect(
        policyWriter`
          UPDATE relationship_types
          SET allows_self = false
          WHERE workspace_id = ${workspaceA}
            AND id = ${ids.relationshipTypeA}
        `,
      ).rejects.toMatchObject({ code: "55P03" });

      await writer.unsafe("COMMIT");
      writerCommitted = true;
      await expect(
        policyWriter`
          UPDATE relationship_types
          SET allows_self = false
          WHERE workspace_id = ${workspaceA}
            AND id = ${ids.relationshipTypeA}
        `,
      ).rejects.toMatchObject({ code: "23514" });
    } finally {
      if (!writerCommitted) await writer.unsafe("ROLLBACK").catch(() => {});
      await policyWriter.unsafe("RESET lock_timeout").catch(() => {});
      await db()`DELETE FROM relationships WHERE workspace_id = ${workspaceA} AND id = ${relationshipId}`;
      await db()`UPDATE relationship_types SET allows_self = false WHERE workspace_id = ${workspaceA} AND id = ${ids.relationshipTypeA}`;
      await Promise.all([writer.end(), policyWriter.end()]);
    }
  });

  it("rejects nonexistent and cross-workspace principals", async () => {
    await expectPrincipalPolicyViolation(
      db()`INSERT INTO saved_queries (id, workspace_id, owner_principal_id, name, query_ast, query_hash, created_by, updated_by) VALUES (${newId()}, ${workspaceA}, ${principalB}, 'Cross owner', '{}', ${"0".repeat(64)}, ${principalA}, ${principalA})`,
    );
    await expectPrincipalPolicyViolation(
      db()`INSERT INTO query_runs (id, workspace_id, actor_principal_id, actor_kind, query_hash, outcome) VALUES (${newId()}, ${workspaceA}, ${principalB}, 'USER', ${"0".repeat(64)}, 'SUCCESS')`,
    );
    await expectForeignKeyViolation(
      db()`INSERT INTO files (id, workspace_id, storage_provider, storage_bucket, storage_key, original_name, byte_size, checksum, uploaded_by, created_by, updated_by) VALUES (${newId()}, ${workspaceA}, 's3', 'test', ${newId()}, 'bad.txt', 1, 'sha256:bad', ${actorB}, ${actorA}, ${actorA})`,
    );
    await expectForeignKeyViolation(
      db()`INSERT INTO upload_sessions (id, workspace_id, actor_id, intended_purpose, max_bytes, object_key, original_name, expires_at, created_by, updated_by) VALUES (${newId()}, ${workspaceA}, ${actorB}, 'test', 1, ${newId()}, 'cross-workspace.txt', now() + interval '1 day', ${actorA}, ${actorA})`,
    );
    await expectForeignKeyViolation(
      db()`INSERT INTO imports (id, workspace_id, file_id, format, idempotency_key, created_by, updated_by) VALUES (${newId()}, ${workspaceA}, ${ids.fileA}, 'csv', ${newId()}, ${actorB}, ${actorA})`,
    );
    await expectForeignKeyViolation(
      db()`INSERT INTO graph_views (id, workspace_id, owner_id, name, created_by, updated_by) VALUES (${newId()}, ${workspaceA}, ${actorB}, 'Cross graph', ${actorA}, ${actorA})`,
    );
    await expectForeignKeyViolation(
      db()`INSERT INTO ai_threads (id, workspace_id, owner_id, title, created_by, updated_by) VALUES (${newId()}, ${workspaceA}, ${actorB}, 'Cross AI', ${actorA}, ${actorA})`,
    );
    await expectForeignKeyViolation(
      db()`INSERT INTO ai_messages (id, workspace_id, thread_id, role, encrypted_content, content_hash, created_by, updated_by) VALUES (${newId()}, ${workspaceA}, ${ids.aiThreadA1}, 'user', 'encrypted:bad', 'sha256:bad', ${actorB}, ${actorA})`,
    );
    await expectForeignKeyViolation(
      db()`INSERT INTO ai_runs (id, workspace_id, thread_id, provider, base_url_fingerprint, model, prompt_hash, configuration_hash, created_by) VALUES (${newId()}, ${workspaceA}, ${ids.aiThreadA1}, 'test', 'base', 'model', 'prompt', 'config', ${actorB})`,
    );
    await expectForeignKeyViolation(
      db()`INSERT INTO jobs (id, workspace_id, kind, encrypted_payload, payload_hash, idempotency_key, created_by, updated_by) VALUES (${newId()}, ${workspaceA}, 'test', 'encrypted:test', 'sha256:test', ${newId()}, ${actorB}, ${actorA})`,
    );
    await expectForeignKeyViolation(
      db()`INSERT INTO idempotency_keys (id, workspace_id, actor_id, operation, key_hash, request_hash, expires_at) VALUES (${newId()}, ${workspaceA}, ${actorB}, 'test', ${newId()}, 'request', now() + interval '1 day')`,
    );
    await expectForeignKeyViolation(
      db()`INSERT INTO webhooks (id, workspace_id, url, encrypted_secret, secret_fingerprint, subscribed_events, created_by, updated_by) VALUES (${newId()}, ${workspaceA}, 'https://example.test/cross', 'encrypted:test', 'sha256:test', ARRAY['test'], ${actorB}, ${actorA})`,
    );
    await expectPrincipalPolicyViolation(
      db()`INSERT INTO saved_queries (id, workspace_id, owner_principal_id, name, query_ast, query_hash, created_by, updated_by) VALUES (${newId()}, ${workspaceA}, ${newId()}, 'Missing owner', '{}', ${"0".repeat(64)}, ${principalA}, ${principalA})`,
    );
  });

  it("binds audit sessions and API keys to the same workspace principal", async () => {
    await expectForeignKeyViolation(
      db()`INSERT INTO audit_events (id, workspace_id, actor_user_id, session_id, action, resource_kind, request_id, outcome) VALUES (${newId()}, ${workspaceA}, ${actorB}, ${ids.sessionA}, 'read', 'person', ${newId()}, 'success')`,
    );
    await expectForeignKeyViolation(
      db()`INSERT INTO audit_events (id, workspace_id, actor_user_id, session_id, action, resource_kind, request_id, outcome) VALUES (${newId()}, ${workspaceA}, ${actorA}, ${ids.sessionB}, 'read', 'person', ${newId()}, 'success')`,
    );
    await expectForeignKeyViolation(
      db()`INSERT INTO audit_events (id, workspace_id, api_key_id, action, resource_kind, request_id, outcome) VALUES (${newId()}, ${workspaceA}, ${ids.apiKeyB}, 'read', 'person', ${newId()}, 'success')`,
    );
    await expect(
      db()`INSERT INTO audit_events (id, workspace_id, actor_user_id, session_id, action, resource_kind, request_id, outcome) VALUES (${newId()}, ${workspaceA}, ${actorA}, ${ids.sessionA}, 'read', 'person', ${newId()}, 'success')`,
    ).resolves.toBeDefined();
  });

  it("retains attribution while logout, API-key revocation, and member offboarding delete live auth rows", async () => {
    const suffix = newId();
    const organizationId = `lifecycle-org-${suffix}`;
    const userId = `lifecycle-user-${suffix}`;
    const memberId = `lifecycle-member-${suffix}`;
    const sessionId = `lifecycle-session-${suffix}`;
    const apiKeyId = `lifecycle-key-${suffix}`;
    const workspaceId = newId();
    const userPrincipalId = newId();
    const apiKeyPrincipalId = newId();
    const savedQueryId = newId();
    const fileId = newId();
    const userAuditId = newId();
    const keyAuditId = newId();

    await db()`INSERT INTO users (id, name, email, email_verified, created_at, updated_at) VALUES (${userId}, 'Lifecycle User', ${`${suffix}@example.test`}, true, now(), now())`;
    await db()`INSERT INTO organizations (id, name, slug, created_at) VALUES (${organizationId}, 'Lifecycle Organization', ${`lifecycle-${suffix}`}, now())`;
    await db()`INSERT INTO workspaces (id, organization_id, name, created_by, updated_by) VALUES (${workspaceId}, ${organizationId}, 'Lifecycle Workspace', ${userId}, ${userId})`;
    await db()`INSERT INTO members (id, organization_id, user_id, role, created_at, workspace_id) VALUES (${memberId}, ${organizationId}, ${userId}, 'owner', now(), ${workspaceId})`;
    await db()`INSERT INTO workspace_principals (id, workspace_id, principal_type, user_id, member_id_snapshot) VALUES (${userPrincipalId}, ${workspaceId}, 'user', ${userId}, ${memberId})`;
    await db()`INSERT INTO sessions (id, expires_at, token, user_id) VALUES (${sessionId}, now() + interval '1 day', ${`token-${suffix}`}, ${userId})`;
    await db()`INSERT INTO saved_queries (id, workspace_id, owner_principal_id, name, query_ast, query_hash, created_by, updated_by) VALUES (${savedQueryId}, ${workspaceId}, ${userPrincipalId}, 'Lifecycle Query', '{}', ${"0".repeat(64)}, ${userPrincipalId}, ${userPrincipalId})`;
    await db()`INSERT INTO files (id, workspace_id, storage_provider, storage_bucket, storage_key, original_name, byte_size, checksum, uploaded_by, created_by, updated_by) VALUES (${fileId}, ${workspaceId}, 'test', 'test', ${`lifecycle/${fileId}`}, 'history.txt', 1, ${`sha256:${suffix}`}, ${userId}, ${userId}, ${userId})`;
    await db()`INSERT INTO audit_events (id, workspace_id, actor_user_id, session_id, action, resource_kind, resource_id, request_id, outcome) VALUES (${userAuditId}, ${workspaceId}, ${userId}, ${sessionId}, 'file.create', 'file', ${fileId}, ${newId()}, 'success')`;

    await expect(
      db()`DELETE FROM sessions WHERE id = ${sessionId}`,
    ).resolves.toBeDefined();
    await expect(
      db()`DELETE FROM members WHERE id = ${memberId}`,
    ).resolves.toBeDefined();

    const [userHistory] = await db()<
      [{ audits: number; files: number; principals: number; queries: number }]
    >`
      SELECT
        (SELECT count(*)::int FROM audit_events WHERE id = ${userAuditId}) AS audits,
        (SELECT count(*)::int FROM files WHERE id = ${fileId}) AS files,
        (SELECT count(*)::int FROM workspace_principals WHERE id = ${userPrincipalId}) AS principals,
        (SELECT count(*)::int FROM saved_queries WHERE id = ${savedQueryId}) AS queries
    `;
    expect(userHistory).toEqual({
      audits: 1,
      files: 1,
      principals: 1,
      queries: 1,
    });
    await expectPrincipalPolicyViolation(
      db()`INSERT INTO saved_queries (id, workspace_id, owner_principal_id, name, query_ast, query_hash, created_by, updated_by) VALUES (${newId()}, ${workspaceId}, ${userPrincipalId}, 'Offboarded Query', '{}', ${"0".repeat(64)}, ${userPrincipalId}, ${userPrincipalId})`,
    );

    await db()`INSERT INTO api_keys (id, config_id, reference_id, key, created_at, updated_at, workspace_id) VALUES (${apiKeyId}, 'organization', ${organizationId}, ${`hashed-${suffix}`}, now(), now(), ${workspaceId})`;
    await db()`INSERT INTO workspace_principals (id, workspace_id, principal_type, api_key_id) VALUES (${apiKeyPrincipalId}, ${workspaceId}, 'api_key', ${apiKeyId})`;
    await db()`INSERT INTO audit_events (id, workspace_id, api_key_id, action, resource_kind, request_id, outcome) VALUES (${keyAuditId}, ${workspaceId}, ${apiKeyId}, 'person.read', 'person', ${newId()}, 'success')`;
    await db()`UPDATE api_keys SET enabled = false WHERE id = ${apiKeyId}`;
    await expect(
      db()`DELETE FROM api_keys WHERE id = ${apiKeyId}`,
    ).resolves.toBeDefined();

    const [keyHistory] = await db()<[{ audits: number; principals: number }]>`
      SELECT
        (SELECT count(*)::int FROM audit_events WHERE id = ${keyAuditId}) AS audits,
        (SELECT count(*)::int FROM workspace_principals WHERE id = ${apiKeyPrincipalId}) AS principals
    `;
    expect(keyHistory).toEqual({ audits: 1, principals: 1 });
    await expect(
      db()`UPDATE audit_events SET outcome = 'failure' WHERE id = ${keyAuditId}`,
    ).rejects.toMatchObject({ code: "55000" });
    await expect(
      db()`DELETE FROM audit_events WHERE id = ${keyAuditId}`,
    ).rejects.toMatchObject({ code: "55000" });
  });

  it("rejects cross-thread AI run inputs and citations", async () => {
    await expectForeignKeyViolation(
      db()`INSERT INTO ai_runs (id, workspace_id, thread_id, message_id, provider, base_url_fingerprint, model, prompt_hash, configuration_hash, created_by) VALUES (${newId()}, ${workspaceA}, ${ids.aiThreadA1}, ${ids.aiMessageA2}, 'test', 'base', 'model', 'prompt', 'config', ${actorA})`,
    );
    await db()`INSERT INTO ai_runs (id, workspace_id, thread_id, message_id, provider, base_url_fingerprint, model, prompt_hash, configuration_hash, created_by) VALUES (${ids.aiRunA1}, ${workspaceA}, ${ids.aiThreadA1}, ${ids.aiMessageA1}, 'test', 'base', 'model', 'prompt', 'config', ${actorA})`;
    await expectForeignKeyViolation(
      db()`INSERT INTO ai_citations (id, workspace_id, thread_id, ai_run_id, message_id, resource_kind, resource_id, claim_text) VALUES (${newId()}, ${workspaceA}, ${ids.aiThreadA2}, ${ids.aiRunA1}, ${ids.aiMessageA2}, 'person', ${personA}, 'Claim')`,
    );
    await expectForeignKeyViolation(
      db()`INSERT INTO ai_citations (id, workspace_id, thread_id, ai_run_id, message_id, resource_kind, resource_id, claim_text) VALUES (${newId()}, ${workspaceA}, ${ids.aiThreadA1}, ${ids.aiRunA1}, ${ids.aiMessageA2}, 'person', ${personA}, 'Claim')`,
    );

    await expect(
      db()`INSERT INTO ai_citations (id, workspace_id, thread_id, ai_run_id, legacy_message_id, resource_kind, resource_id, claim_text) VALUES (${newId()}, ${workspaceA}, ${ids.aiThreadA1}, ${ids.aiRunA1}, ${newId()}, 'person', ${personA}, 'Forged legacy claim')`,
    ).rejects.toMatchObject({ code: "23514" });

    const citationId = newId();
    await db()`INSERT INTO ai_citations (id, workspace_id, thread_id, ai_run_id, message_id, resource_kind, resource_id, claim_text) VALUES (${citationId}, ${workspaceA}, ${ids.aiThreadA1}, ${ids.aiRunA1}, ${ids.aiMessageA1}, 'person', ${personA}, 'Valid claim')`;
    await expect(
      db()`UPDATE ai_citations SET message_id = NULL, legacy_message_id = ${newId()} WHERE id = ${citationId}`,
    ).rejects.toMatchObject({ code: "55000" });
  });

  it("accepts zero or one note subject and rejects two", async () => {
    await expect(
      db()`INSERT INTO notes (id, workspace_id, plain_text, created_by, updated_by) VALUES (${newId()}, ${workspaceA}, 'Workspace note', ${actorA}, ${actorA})`,
    ).resolves.toBeDefined();
    await expect(
      db()`INSERT INTO notes (id, workspace_id, person_id, plain_text, created_by, updated_by) VALUES (${newId()}, ${workspaceA}, ${personA}, 'Person note', ${actorA}, ${actorA})`,
    ).resolves.toBeDefined();
    await expect(
      db()`INSERT INTO notes (id, workspace_id, person_id, fact_id, plain_text, created_by, updated_by) VALUES (${newId()}, ${workspaceA}, ${personA}, ${ids.factA}, 'Ambiguous note', ${actorA}, ${actorA})`,
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("rejects cross-workspace evidence references", async () => {
    await expectForeignKeyViolation(
      db()`INSERT INTO fact_evidence (id, workspace_id, fact_id, evidence_item_id, created_by) VALUES (${newId()}, ${workspaceA}, ${ids.factA}, ${ids.evidenceB}, ${actorA})`,
    );
  });

  it("rejects cross-workspace file and ingestion references", async () => {
    await expectForeignKeyViolation(
      db()`INSERT INTO imports (id, workspace_id, file_id, format, idempotency_key, created_by, updated_by) VALUES (${newId()}, ${workspaceA}, ${ids.fileB}, 'csv', ${newId()}, ${actorA}, ${actorA})`,
    );
  });

  it("rejects cross-workspace saved-query references", async () => {
    await expectForeignKeyViolation(
      db()`INSERT INTO query_runs (id, workspace_id, saved_query_id, actor_principal_id, actor_kind, query_hash, outcome) VALUES (${newId()}, ${workspaceA}, ${ids.savedQueryB}, ${principalA}, 'USER', ${"0".repeat(64)}, 'SUCCESS')`,
    );
  });

  it("rejects cross-workspace graph references", async () => {
    await expectForeignKeyViolation(
      db()`INSERT INTO graph_view_nodes (id, workspace_id, graph_view_id, person_id, created_by, updated_by) VALUES (${newId()}, ${workspaceA}, ${ids.graphViewB}, ${personA}, ${actorA}, ${actorA})`,
    );
  });

  it("rejects cross-workspace AI references", async () => {
    await expectForeignKeyViolation(
      db()`INSERT INTO ai_messages (id, workspace_id, thread_id, role, encrypted_content, content_hash, created_by, updated_by) VALUES (${newId()}, ${workspaceA}, ${ids.aiThreadB}, 'user', 'encrypted:test', 'sha256:test', ${actorA}, ${actorA})`,
    );
  });

  it("rejects cross-workspace operations references", async () => {
    await expectForeignKeyViolation(
      db()`INSERT INTO webhook_deliveries (id, workspace_id, webhook_id, event_id, attempt, signature_algorithm) VALUES (${newId()}, ${workspaceA}, ${ids.webhookB}, ${newId()}, 1, 'hmac-sha256')`,
    );
  });

  it("enforces import execution-job tenancy, deletion, and claim-generation invariants", async () => {
    const importId = newId();
    const duplicateImportId = newId();
    const jobA = newId();
    const jobB = newId();

    await db()`INSERT INTO jobs (id, workspace_id, kind, encrypted_payload, payload_hash, idempotency_key, created_by) VALUES (${jobA}, ${workspaceA}, 'import_execute', 'sealed:a', 'sha256:a', ${`job-a-${jobA}`}, ${actorA}), (${jobB}, ${workspaceB}, 'import_execute', 'sealed:b', 'sha256:b', ${`job-b-${jobB}`}, ${actorB})`;
    await db()`INSERT INTO imports (id, workspace_id, file_id, format, idempotency_key, created_by, updated_by) VALUES (${importId}, ${workspaceA}, ${ids.fileA}, 'csv', ${`import-${importId}`}, ${actorA}, ${actorA})`;

    const [defaults] = await db()<
      [{ claim_generation: number; execution_job_id: string | null }]
    >`
      SELECT job.claim_generation, execution.execution_job_id
      FROM jobs AS job
      CROSS JOIN imports AS execution
      WHERE job.id = ${jobA} AND execution.id = ${importId}
    `;
    expect(defaults).toEqual({
      claim_generation: 0,
      execution_job_id: null,
    });

    await expect(
      db()`UPDATE jobs SET claim_generation = -1 WHERE id = ${jobA}`,
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      db()`UPDATE jobs SET claim_generation = 1 WHERE id = ${jobA}`,
    ).resolves.toBeDefined();

    await expectForeignKeyViolation(
      db()`UPDATE imports SET execution_job_id = ${jobB} WHERE id = ${importId}`,
    );
    await db()`UPDATE imports SET execution_job_id = ${jobA} WHERE id = ${importId}`;
    await expect(
      db()`INSERT INTO imports (id, workspace_id, file_id, format, idempotency_key, execution_job_id, created_by, updated_by) VALUES (${duplicateImportId}, ${workspaceA}, ${ids.fileA}, 'csv', ${`duplicate-import-${duplicateImportId}`}, ${jobA}, ${actorA}, ${actorA})`,
    ).rejects.toMatchObject({ code: "23505" });
    await expect(
      db()`DELETE FROM jobs WHERE id = ${jobA}`,
    ).rejects.toMatchObject({ code: "23001" });
    await db()`UPDATE imports SET execution_job_id = NULL WHERE id = ${importId}`;
    await expect(
      db()`DELETE FROM jobs WHERE id = ${jobA}`,
    ).resolves.toBeDefined();
  });

  it("rejects every deferred Task 4 reference across workspaces", async () => {
    await expectForeignKeyViolation(
      db()`INSERT INTO facts (id, workspace_id, person_id, fact_definition_id, namespace, field_key, label, value_type, place_id, created_by, updated_by) VALUES (${newId()}, ${workspaceA}, ${personA}, ${ids.factDefinitionPlaceA}, 'seed', 'place', 'Place', 'place_reference', ${ids.placeB}, ${actorA}, ${actorA})`,
    );
    await expectForeignKeyViolation(
      db()`INSERT INTO facts (id, workspace_id, person_id, fact_definition_id, namespace, field_key, label, value_type, file_id, created_by, updated_by) VALUES (${newId()}, ${workspaceA}, ${personA}, ${ids.factDefinitionFileA}, 'seed', 'file', 'File', 'file_reference', ${ids.fileB}, ${actorA}, ${actorA})`,
    );
    await expectForeignKeyViolation(
      db()`INSERT INTO person_events (id, workspace_id, person_id, event_kind, title, place_id, created_by, updated_by) VALUES (${newId()}, ${workspaceA}, ${personA}, 'visit', 'Visited London', ${ids.placeB}, ${actorA}, ${actorA})`,
    );
    await expectForeignKeyViolation(
      db()`UPDATE people SET primary_photo_file_id = ${ids.fileB} WHERE workspace_id = ${workspaceA} AND id = ${personA}`,
    );
    await expectForeignKeyViolation(
      db()`INSERT INTO consent_records (id, workspace_id, person_id, purpose, status, source, effective_from, evidence_id, created_by, updated_by) VALUES (${newId()}, ${workspaceA}, ${personA}, 'research', 'granted', 'test', now(), ${ids.evidenceB}, ${actorA}, ${actorA})`,
    );
    await expectForeignKeyViolation(
      db()`INSERT INTO external_records (id, workspace_id, source_system, external_type, external_id, person_id, import_id, last_seen_at, created_by, updated_by) VALUES (${newId()}, ${workspaceA}, 'test', 'person', ${newId()}, ${personA}, ${ids.importB}, now(), ${actorA}, ${actorA})`,
    );
    await expectForeignKeyViolation(
      db()`INSERT INTO deletion_requests (id, workspace_id, requester_id, scope, state, export_reference_id, created_by, updated_by) VALUES (${newId()}, ${workspaceA}, ${actorA}, '{}', 'requested', ${ids.fileB}, ${actorA}, ${actorA})`,
    );
  });

  it("allows an explicit workspace purge to cascade through retained attribution", async () => {
    const suffix = newId();
    const organizationId = `purge-org-${suffix}`;
    const userId = `purge-user-${suffix}`;
    const memberId = `purge-member-${suffix}`;
    const workspaceId = newId();
    const principalId = newId();
    const queryId = newId();
    const auditId = newId();
    const fileId = newId();
    const importId = newId();
    const jobId = newId();

    await db()`INSERT INTO users (id, name, email, email_verified, created_at, updated_at) VALUES (${userId}, 'Purge User', ${`${suffix}@example.test`}, true, now(), now())`;
    await db()`INSERT INTO organizations (id, name, slug, created_at) VALUES (${organizationId}, 'Purge Organization', ${`purge-${suffix}`}, now())`;
    await db()`INSERT INTO workspaces (id, organization_id, name, created_by, updated_by) VALUES (${workspaceId}, ${organizationId}, 'Purge Workspace', ${userId}, ${userId})`;
    await db()`INSERT INTO members (id, organization_id, user_id, role, created_at) VALUES (${memberId}, ${organizationId}, ${userId}, 'owner', now())`;
    await db()`INSERT INTO workspace_principals (id, workspace_id, principal_type, user_id, member_id_snapshot) VALUES (${principalId}, ${workspaceId}, 'user', ${userId}, ${memberId})`;
    await db()`INSERT INTO files (id, workspace_id, storage_provider, storage_bucket, storage_key, original_name, byte_size, checksum, uploaded_by, created_by, updated_by) VALUES (${fileId}, ${workspaceId}, 's3', 'test', ${`purge/${fileId}`}, 'purge.csv', 1, 'sha256:purge', ${userId}, ${userId}, ${userId})`;
    await db()`INSERT INTO jobs (id, workspace_id, kind, encrypted_payload, payload_hash, idempotency_key, created_by) VALUES (${jobId}, ${workspaceId}, 'import_execute', 'sealed:purge', 'sha256:purge', ${`purge-job-${jobId}`}, ${userId})`;
    await db()`INSERT INTO imports (id, workspace_id, file_id, format, idempotency_key, execution_job_id, created_by, updated_by) VALUES (${importId}, ${workspaceId}, ${fileId}, 'csv', ${`purge-import-${importId}`}, ${jobId}, ${userId}, ${userId})`;
    await db()`INSERT INTO saved_queries (id, workspace_id, owner_principal_id, name, query_ast, query_hash, created_by, updated_by) VALUES (${queryId}, ${workspaceId}, ${principalId}, 'Purge Query', '{}', ${"0".repeat(64)}, ${principalId}, ${principalId})`;
    await db()`INSERT INTO audit_events (id, workspace_id, actor_user_id, action, resource_kind, request_id, outcome) VALUES (${auditId}, ${workspaceId}, ${userId}, 'workspace.delete', 'workspace', ${newId()}, 'success')`;

    await expect(
      db()`DELETE FROM workspaces WHERE id = ${workspaceId}`,
    ).resolves.toBeDefined();

    const [remaining] = await db()<
      [
        {
          audits: number;
          imports: number;
          jobs: number;
          members: number;
          principals: number;
          queries: number;
        },
      ]
    >`
      SELECT
        (SELECT count(*)::int FROM audit_events WHERE id = ${auditId}) AS audits,
        (SELECT count(*)::int FROM imports WHERE id = ${importId}) AS imports,
        (SELECT count(*)::int FROM jobs WHERE id = ${jobId}) AS jobs,
        (SELECT count(*)::int FROM members WHERE id = ${memberId}) AS members,
        (SELECT count(*)::int FROM workspace_principals WHERE id = ${principalId}) AS principals,
        (SELECT count(*)::int FROM saved_queries WHERE id = ${queryId}) AS queries
    `;
    expect(remaining).toEqual({
      audits: 0,
      imports: 0,
      jobs: 0,
      members: 0,
      principals: 0,
      queries: 0,
    });
  });
});
