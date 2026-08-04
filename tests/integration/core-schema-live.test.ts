// @vitest-environment node

import { setTimeout as delay } from "node:timers/promises";

import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { newId } from "@/db/id";
import { uploadSessions } from "@/db/schema";
import { assertTestDatabaseResetAllowed } from "../support/database-reset-guard";

const databaseUrl = process.env.TEST_DATABASE_URL;
const resetAllowed = process.env.ALLOW_TEST_DATABASE_RESET;
const liveDescribe = databaseUrl || resetAllowed ? describe : describe.skip;
const sqlClient = databaseUrl
  ? postgres(databaseUrl, { max: 1, onnotice: () => undefined, prepare: false })
  : undefined;

type FactValueType =
  | "text"
  | "rich_text"
  | "integer"
  | "decimal"
  | "boolean"
  | "date"
  | "date_range"
  | "timestamp"
  | "duration"
  | "quantity"
  | "uri"
  | "json"
  | "person_reference"
  | "place_reference"
  | "file_reference";

type FactValues = {
  valueText?: string;
  valueDecimal?: string;
  valueBoolean?: boolean;
  valueDateStart?: string;
  valueDateEnd?: string;
  valueTimestamp?: string;
  valueJson?: Record<string, unknown>;
  referencedPersonId?: string;
  placeId?: string;
  fileId?: string;
  encryptedValue?: string;
  blindIndex?: string;
  unit?: string;
};

type WorkspaceFixture = {
  fileId: string;
  memberId: string;
  organizationId: string;
  personId: string;
  placeId: string;
  userId: string;
  workspaceId: string;
};

const db = () => {
  if (!sqlClient) throw new Error("TEST_DATABASE_URL is required");
  return sqlClient;
};

async function seedWorkspace(label: string): Promise<WorkspaceFixture> {
  const organizationId = `org-${label}-${newId()}`;
  const userId = `user-${label}-${newId()}`;
  const workspaceId = newId();
  const personId = newId();
  const fileId = newId();
  const placeId = newId();
  const memberId = `member-${newId()}`;

  await db()`
    INSERT INTO users (id, name, email, email_verified, created_at, updated_at)
    VALUES (
      ${userId},
      ${`User ${label}`},
      ${`${label}-${newId()}@example.test`},
      true,
      now(),
      now()
    )
  `;
  await db()`
    INSERT INTO organizations (id, name, slug, created_at)
    VALUES (${organizationId}, ${`Organization ${label}`}, ${`${label}-${newId()}`}, now())
  `;
  await db()`
    INSERT INTO workspaces (
      id,
      organization_id,
      name,
      created_by,
      updated_by
    ) VALUES (
      ${workspaceId},
      ${organizationId},
      ${`Workspace ${label}`},
      ${userId},
      ${userId}
    )
  `;
  await db()`
    INSERT INTO members (
      id,
      organization_id,
      user_id,
      role,
      created_at,
      workspace_id
    ) VALUES (
      ${memberId},
      ${organizationId},
      ${userId},
      'owner',
      now(),
      ${workspaceId}
    )
  `;
  await db()`
    INSERT INTO workspace_principals (
      id,
      workspace_id,
      principal_type,
      user_id,
      member_id_snapshot
    ) VALUES (
      ${newId()},
      ${workspaceId},
      'user',
      ${userId},
      ${memberId}
    )
  `;
  await db()`
    INSERT INTO people (
      id,
      workspace_id,
      display_name,
      created_by,
      updated_by
    ) VALUES (
      ${personId},
      ${workspaceId},
      ${`Person ${label}`},
      ${userId},
      ${userId}
    )
  `;

  await db()`
    INSERT INTO places (
      id,
      workspace_id,
      name,
      kind,
      created_by,
      updated_by
    ) VALUES (
      ${placeId},
      ${workspaceId},
      ${`Place ${label}`},
      'test',
      ${userId},
      ${userId}
    )
  `;
  await db()`
    INSERT INTO files (
      id,
      workspace_id,
      storage_provider,
      storage_bucket,
      storage_key,
      original_name,
      byte_size,
      checksum,
      uploaded_by,
      created_by,
      updated_by
    ) VALUES (
      ${fileId},
      ${workspaceId},
      'test',
      'test',
      ${`fixtures/${fileId}`},
      'fixture.txt',
      1,
      ${`sha256:${fileId}`},
      ${userId},
      ${userId},
      ${userId}
    )
  `;

  return {
    fileId,
    memberId,
    organizationId,
    personId,
    placeId,
    userId,
    workspaceId,
  };
}

async function seedDefinition(
  fixture: WorkspaceFixture,
  valueType: FactValueType,
  namespace = "core",
  fieldKey = `${valueType}-${newId()}`,
): Promise<{ fieldKey: string; id: string; namespace: string }> {
  const id = newId();

  await db()`
    INSERT INTO fact_definitions (
      id,
      workspace_id,
      namespace,
      field_key,
      label,
      allowed_value_type,
      created_by,
      updated_by
    ) VALUES (
      ${id},
      ${fixture.workspaceId},
      ${namespace},
      ${fieldKey},
      ${fieldKey},
      ${valueType},
      ${fixture.userId},
      ${fixture.userId}
    )
  `;

  return { fieldKey, id, namespace };
}

async function insertFact(options: {
  definition: { fieldKey: string; id: string; namespace: string };
  fixture: WorkspaceFixture;
  id?: string;
  personId?: string;
  supersedesFactId?: string;
  type: FactValueType;
  values: FactValues;
}): Promise<string> {
  const id = options.id ?? newId();
  const values = options.values;

  await db()`
    INSERT INTO facts (
      id,
      workspace_id,
      person_id,
      fact_definition_id,
      namespace,
      field_key,
      label,
      value_type,
      value_text,
      value_decimal,
      value_boolean,
      value_date_start,
      value_date_end,
      value_timestamp,
      value_json,
      referenced_person_id,
      place_id,
      file_id,
      unit,
      encrypted_value,
      blind_index,
      supersedes_fact_id,
      created_by,
      updated_by
    ) VALUES (
      ${id},
      ${options.fixture.workspaceId},
      ${options.personId ?? options.fixture.personId},
      ${options.definition.id},
      ${options.definition.namespace},
      ${options.definition.fieldKey},
      ${options.definition.fieldKey},
      ${options.type},
      ${values.valueText ?? null},
      ${values.valueDecimal ?? null},
      ${values.valueBoolean ?? null},
      ${values.valueDateStart ?? null},
      ${values.valueDateEnd ?? null},
      ${values.valueTimestamp ?? null},
      ${values.valueJson ? JSON.stringify(values.valueJson) : null},
      ${values.referencedPersonId ?? null},
      ${values.placeId ?? null},
      ${values.fileId ?? null},
      ${values.unit ?? null},
      ${values.encryptedValue ?? null},
      ${values.blindIndex ?? null},
      ${options.supersedesFactId ?? null},
      ${options.fixture.userId},
      ${options.fixture.userId}
    )
  `;

  return id;
}

function validValues(
  type: FactValueType,
  fixture: WorkspaceFixture,
): FactValues {
  switch (type) {
    case "text":
      return { valueText: "Ada" };
    case "rich_text":
      return { valueText: "<p>Ada</p>" };
    case "integer":
      return { valueDecimal: "42" };
    case "decimal":
      return { valueDecimal: "42.5" };
    case "boolean":
      return { valueBoolean: true };
    case "date":
      return { valueDateStart: "2026-07-10" };
    case "date_range":
      return {
        valueDateEnd: "2026-07-10",
        valueDateStart: "2026-07-01",
      };
    case "timestamp":
      return { valueTimestamp: "2026-07-10T12:00:00.000Z" };
    case "duration":
      return { unit: "day", valueDecimal: "3" };
    case "quantity":
      return { unit: "kg", valueDecimal: "7.5" };
    case "uri":
      return { valueText: "https://example.test/ada" };
    case "json":
      return { valueJson: { value: "Ada" } };
    case "person_reference":
      return { referencedPersonId: fixture.personId };
    case "place_reference":
      return { placeId: fixture.placeId };
    case "file_reference":
      return { fileId: fixture.fileId };
  }
}

function invalidValues(type: FactValueType): FactValues {
  switch (type) {
    case "text":
    case "rich_text":
    case "uri":
      return { valueDecimal: "1" };
    case "integer":
      return { valueDecimal: "1.5" };
    case "decimal":
      return { valueBoolean: true };
    case "boolean":
      return { valueText: "true" };
    case "date":
      return { valueText: "2026-07-10" };
    case "date_range":
      return { valueDateStart: "2026-07-10" };
    case "timestamp":
      return { valueText: "2026-07-10T12:00:00Z" };
    case "duration":
    case "quantity":
      return { valueDecimal: "1" };
    case "json":
      return { valueText: "{}" };
    case "person_reference":
    case "place_reference":
    case "file_reference":
      return { valueText: newId() };
  }
}

const factValueTypes: FactValueType[] = [
  "text",
  "rich_text",
  "integer",
  "decimal",
  "boolean",
  "date",
  "date_range",
  "timestamp",
  "duration",
  "quantity",
  "uri",
  "json",
  "person_reference",
  "place_reference",
  "file_reference",
];

liveDescribe("core schema on PostgreSQL 18", () => {
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
    await db().unsafe("DROP SCHEMA IF EXISTS public CASCADE");
    await db().unsafe("CREATE SCHEMA public");
    await migrate(drizzle(db()), { migrationsFolder: "drizzle" });
  }, 120_000);

  afterAll(async () => {
    await sqlClient?.end();
  });

  it("applies the committed migration", async () => {
    const [result] = await db()<[{ count: string }]>`
      SELECT count(*)::text AS count
      FROM drizzle.__drizzle_migrations
    `;

    expect(result.count).toBe("20");
  });

  it("installs the Task 12 result lifecycle and restrictive ownership constraints", async () => {
    const triggers = await db()<{ tgname: string }[]>`
      SELECT tgname
      FROM pg_trigger
      WHERE NOT tgisinternal
        AND tgname IN (
          'analysis_results_immutable_trigger',
          'analysis_results_lifecycle_trigger',
          'analysis_runs_finalize_only_trigger'
        )
      ORDER BY tgname
    `;
    expect(triggers.map(({ tgname }) => tgname)).toEqual([
      "analysis_results_lifecycle_trigger",
      "analysis_runs_finalize_only_trigger",
    ]);
    const foreignKeys = await db()<{ conname: string; definition: string }[]>`
      SELECT conname, pg_get_constraintdef(oid) AS definition
      FROM pg_constraint
      WHERE conname IN (
        'analysis_results_workspace_run_fk',
        'analysis_results_workspace_person_fk',
        'analysis_results_workspace_relationship_fk'
      )
      ORDER BY conname
    `;
    expect(foreignKeys).toHaveLength(3);
    expect(
      foreignKeys.every(({ definition }) =>
        definition.includes("ON DELETE RESTRICT"),
      ),
    ).toBe(true);
  });

  it("serializes result insertion against run finalization and rejects truly late rows", async () => {
    const fixture = await seedWorkspace("analysis-result-finalize-race");
    const [{ id: principalId }] = await db()<[{ id: string }]>`
      SELECT id
      FROM workspace_principals
      WHERE workspace_id = ${fixture.workspaceId}
        AND user_id = ${fixture.userId}
    `;
    const snapshotId = newId();
    const runId = newId();
    await db()`
      INSERT INTO graph_snapshots (
        id, workspace_id, manifest_schema, manifest_hash, manifest_material,
        query_input, query_hash, authorization_hash, actor_principal_id,
        actor_kind, included_person_versions, included_relationship_versions,
        included_relationship_type_versions, algorithm, algorithm_version,
        algorithm_config_hash, algorithm_configuration, runtime_contract,
        created_by
      ) VALUES (
        ${snapshotId}, ${fixture.workspaceId},
        'humans.graph-snapshot-manifest.v1', ${"11".repeat(32)},
        '{"fixture":"finalize-race"}'::jsonb, '{}'::jsonb, ${"22".repeat(32)},
        ${"33".repeat(32)}, ${principalId}, 'USER', '{}'::jsonb, '{}'::jsonb,
        '{}'::jsonb, 'DEGREE', 'test-v1', ${"44".repeat(32)},
        '{"projection":"test-v1"}'::jsonb, '{"serviceVersion":"test"}'::jsonb,
        ${fixture.userId}
      )
    `;
    await db()`
      INSERT INTO analysis_runs (
        id, workspace_id, algorithm, algorithm_version, configuration_hash,
        graph_snapshot_id, actor_principal_id, actor_kind, configuration,
        state, started_at, created_by
      ) VALUES (
        ${runId}, ${fixture.workspaceId}, 'DEGREE', 'test-v1',
        ${"44".repeat(32)}, ${snapshotId}, ${principalId}, 'USER',
        '{"projection":"test-v1"}'::jsonb, 'running', now(), ${fixture.userId}
      )
    `;

    const inserter = postgres(databaseUrl!, { max: 1, prepare: false });
    const finalizer = postgres(databaseUrl!, { max: 1, prepare: false });
    const [{ pid: finalizerPid }] = await finalizer<[{ pid: number }]>`
      SELECT pg_backend_pid() AS pid
    `;
    let insertTransactionOpen = false;
    try {
      await inserter`BEGIN`;
      insertTransactionOpen = true;
      await inserter`
        INSERT INTO analysis_results (
          id, workspace_id, analysis_run_id, result_kind, payload_schema,
          payload_hash, export_label, subject_person_id, numeric_value, rank
        ) VALUES (
          ${newId()}, ${fixture.workspaceId}, ${runId}, 'degree',
          'humans.graph-analysis-result.v1', ${"55".repeat(32)}, 'degree',
          ${fixture.personId}, 1, 1
        )
      `;

      let finalizeOutcome:
        | { error: unknown; status: "rejected" }
        | { status: "fulfilled" }
        | { status: "pending" } = { status: "pending" };
      const finalize = finalizer`
        UPDATE analysis_runs
        SET state = 'completed', completed_at = now()
        WHERE workspace_id = ${fixture.workspaceId} AND id = ${runId}
      `.then(
        () => {
          finalizeOutcome = { status: "fulfilled" };
          return finalizeOutcome;
        },
        (error: unknown) => {
          finalizeOutcome = { error, status: "rejected" };
          return finalizeOutcome;
        },
      );

      let observedLockWait = false;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const [activity] = await db()<[{ wait_event_type: string | null }]>`
          SELECT wait_event_type
          FROM pg_stat_activity
          WHERE pid = ${finalizerPid}
        `;
        if (activity?.wait_event_type === "Lock") {
          observedLockWait = true;
          break;
        }
        if (finalizeOutcome.status !== "pending") break;
        await delay(10);
      }
      expect(observedLockWait).toBe(true);
      expect(finalizeOutcome.status).toBe("pending");

      await inserter`COMMIT`;
      insertTransactionOpen = false;
      expect(await finalize).toEqual({ status: "fulfilled" });
    } finally {
      if (insertTransactionOpen) await inserter`ROLLBACK`;
      await inserter.end();
      await finalizer.end();
    }

    await expect(
      db()`
        INSERT INTO analysis_results (
          id, workspace_id, analysis_run_id, result_kind, payload_schema,
          payload_hash, export_label, subject_person_id, numeric_value, rank
        ) VALUES (
          ${newId()}, ${fixture.workspaceId}, ${runId}, 'degree',
          'humans.graph-analysis-result.v1', ${"66".repeat(32)}, 'degree',
          ${fixture.personId}, 2, 2
        )
      `,
    ).rejects.toMatchObject({ code: "23514" });
    const [{ count }] = await db()<[{ count: string }]>`
      SELECT count(*)::text AS count
      FROM analysis_results
      WHERE analysis_run_id = ${runId}
    `;
    expect(count).toBe("1");
  });

  it("installs nullable protected-value versions with future-row defaults and partial indexes", async () => {
    const columns = await db()<
      {
        column_default: string | null;
        is_nullable: string;
        table_name: string;
      }[]
    >`
      SELECT table_name, is_nullable, column_default
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND column_name = 'blind_index_version'
        AND table_name IN ('contact_points', 'person_identifiers')
      ORDER BY table_name
    `;
    expect(columns).toEqual([
      {
        column_default: "1",
        is_nullable: "YES",
        table_name: "contact_points",
      },
      {
        column_default: "1",
        is_nullable: "YES",
        table_name: "person_identifiers",
      },
    ]);
    const indexes = await db()<{ indexdef: string; indexname: string }[]>`
      SELECT indexname, indexdef
      FROM pg_indexes
      WHERE schemaname = 'public'
        AND indexname IN (
          'contact_points_workspace_blind_index_idx',
          'person_identifiers_workspace_blind_index_idx'
        )
      ORDER BY indexname
    `;
    expect(indexes).toHaveLength(2);
    for (const { indexdef } of indexes) {
      expect(indexdef).toContain("blind_index_version = 1");
      expect(indexdef).toContain("deleted_at IS NULL");
    }
  });

  it("stores required upload metadata with a typed default and byte constraints", async () => {
    const fixture = await seedWorkspace("upload-session-metadata");
    const typedDb = drizzle(db(), { schema: { uploadSessions } });
    const uploadSessionId = newId();

    await typedDb.insert(uploadSessions).values({
      actorId: fixture.userId,
      createdBy: fixture.userId,
      expiresAt: new Date(Date.now() + 60_000),
      id: uploadSessionId,
      intendedPurpose: "EVIDENCE",
      maxBytes: 1024,
      objectKey: `uploads/${uploadSessionId}/${newId()}`,
      originalName: "evidence.pdf",
      updatedBy: fixture.userId,
      workspaceId: fixture.workspaceId,
    });

    const [stored] = await typedDb
      .select({
        originalName: uploadSessions.originalName,
        sensitivity: uploadSessions.sensitivity,
      })
      .from(uploadSessions)
      .where(eq(uploadSessions.id, uploadSessionId));
    expect(stored).toEqual({
      originalName: "evidence.pdf",
      sensitivity: "internal",
    });

    await expect(
      db()`
        INSERT INTO upload_sessions (
          id, workspace_id, actor_id, intended_purpose, max_bytes, object_key,
          expires_at, created_by, updated_by
        ) VALUES (
          ${newId()}, ${fixture.workspaceId}, ${fixture.userId}, 'EVIDENCE', 1,
          ${`uploads/${newId()}/${newId()}`}, now() + interval '1 minute',
          ${fixture.userId}, ${fixture.userId}
        )
      `,
    ).rejects.toMatchObject({ code: "23502" });
    await expect(
      db()`
        INSERT INTO upload_sessions (
          id, workspace_id, actor_id, intended_purpose, max_bytes, object_key,
          original_name, sensitivity, expires_at, created_by, updated_by
        ) VALUES (
          ${newId()}, ${fixture.workspaceId}, ${fixture.userId}, 'EVIDENCE', 1,
          ${`uploads/${newId()}/${newId()}`}, 'invalid.txt', 'secret',
          now() + interval '1 minute', ${fixture.userId}, ${fixture.userId}
        )
      `,
    ).rejects.toMatchObject({ code: "22P02" });
    await expect(
      db()`
        INSERT INTO upload_sessions (
          id, workspace_id, actor_id, intended_purpose, max_bytes, object_key,
          original_name, sensitivity, expires_at, created_by, updated_by
        ) VALUES (
          ${newId()}, ${fixture.workspaceId}, ${fixture.userId}, 'EVIDENCE', 1,
          ${`uploads/${newId()}/${newId()}`}, 'null-sensitivity.txt', NULL,
          now() + interval '1 minute', ${fixture.userId}, ${fixture.userId}
        )
      `,
    ).rejects.toMatchObject({ code: "23502" });

    for (const invalidName of ["", "é".repeat(128)]) {
      await expect(
        db()`
          INSERT INTO upload_sessions (
            id, workspace_id, actor_id, intended_purpose, max_bytes, object_key,
            original_name, expires_at, created_by, updated_by
          ) VALUES (
            ${newId()}, ${fixture.workspaceId}, ${fixture.userId}, 'EVIDENCE', 1,
            ${`uploads/${newId()}/${newId()}`}, ${invalidName},
            now() + interval '1 minute', ${fixture.userId}, ${fixture.userId}
          )
        `,
      ).rejects.toMatchObject({ code: "23514" });
    }
  });

  it("runs Better Auth's server API and adapter against every configured auth model", async () => {
    const { createHumansAuth } = await import("@/lib/auth/config");
    const instance = createHumansAuth({
      database: drizzle(db(), { schema: await import("@/db/schema") }),
      emailSender: { send: async () => ({ id: "test" }) },
      settings: {
        NEXT_PUBLIC_APP_URL: "http://localhost:3000",
        AUTH_SECRET: "task-4-live-adapter-smoke-secret",
        AUTH_ENCRYPTION_KEY: "02".repeat(32),
        AUTH_REGISTRATION_MODE: "public",
        AUTH_SECURE_COOKIES: false,
        AUTH_TRUSTED_ORIGINS: ["http://localhost:3000"],
      },
    });
    const context = await instance.$context;
    const userId = `auth-user-${newId()}`;
    const organizationId = `auth-org-${newId()}`;
    const workspaceId = newId();

    await context.adapter.create({
      data: {
        createdAt: new Date(),
        email: `${newId()}@example.test`,
        emailVerified: true,
        id: userId,
        name: "Adapter User",
        twoFactorEnabled: true,
        updatedAt: new Date(),
        username: `user_${newId().replaceAll("-", "")}`,
      },
      forceAllowId: true,
      model: "user",
    });
    await context.adapter.create({
      data: {
        createdAt: new Date(),
        id: organizationId,
        name: "Adapter Organization",
        slug: `org-${newId()}`,
      },
      forceAllowId: true,
      model: "organization",
    });
    await db()`
      INSERT INTO workspaces (
        id,
        organization_id,
        name,
        created_by,
        updated_by
      ) VALUES (
        ${workspaceId},
        ${organizationId},
        'Adapter Workspace',
        ${userId},
        ${userId}
      )
    `;
    await context.adapter.create({
      data: {
        backupCodes: "encrypted-backup-codes",
        id: `2fa-${newId()}`,
        secret: "encrypted-secret",
        userId,
      },
      forceAllowId: true,
      model: "twoFactor",
    });
    const createdMember = await instance.api.addMember({
      body: {
        organizationId,
        role: "owner",
        userId,
      },
    });
    expect(createdMember.workspaceId).toBe(workspaceId);
    await context.adapter.create({
      data: {
        configId: "organization",
        createdAt: new Date(),
        enabled: true,
        id: `key-${newId()}`,
        key: `hashed-${newId()}`,
        permissions: JSON.stringify({ people: ["read"] }),
        referenceId: organizationId,
        requestCount: 0,
        updatedAt: new Date(),
      },
      forceAllowId: true,
      model: "apikey",
    });

    const [stored] = await db()<
      [
        {
          api_key_count: string;
          api_key_workspace_id: string;
          member_count: string;
          member_workspace_id: string;
          two_factor_count: string;
        },
      ]
    >`
      SELECT
        (SELECT count(*)::text FROM api_keys WHERE reference_id = ${organizationId}) AS api_key_count,
        (SELECT workspace_id::text FROM api_keys WHERE reference_id = ${organizationId} LIMIT 1) AS api_key_workspace_id,
        (SELECT count(*)::text FROM members WHERE workspace_id = ${workspaceId}) AS member_count,
        (SELECT workspace_id::text FROM members WHERE organization_id = ${organizationId} AND user_id = ${userId} LIMIT 1) AS member_workspace_id,
        (SELECT count(*)::text FROM two_factors WHERE user_id = ${userId}) AS two_factor_count
    `;

    expect(stored).toEqual({
      api_key_count: "1",
      api_key_workspace_id: workspaceId,
      member_count: "1",
      member_workspace_id: workspaceId,
      two_factor_count: "1",
    });
  });

  it("rejects cross-workspace people references", async () => {
    const first = await seedWorkspace("tenant-a");
    const second = await seedWorkspace("tenant-b");
    const definition = await seedDefinition(first, "text");

    await expect(
      db()`
        INSERT INTO person_names (
          id, workspace_id, person_id, kind, full_name, created_by, updated_by
        ) VALUES (
          ${newId()}, ${first.workspaceId}, ${second.personId}, 'preferred',
          'Wrong tenant', ${first.userId}, ${first.userId}
        )
      `,
    ).rejects.toMatchObject({ code: "23503" });
    await expect(
      db()`
        INSERT INTO person_events (
          id, workspace_id, person_id, event_kind, title, created_by, updated_by
        ) VALUES (
          ${newId()}, ${first.workspaceId}, ${second.personId}, 'test',
          'Wrong tenant', ${first.userId}, ${first.userId}
        )
      `,
    ).rejects.toMatchObject({ code: "23503" });
    await expect(
      insertFact({
        definition,
        fixture: first,
        personId: second.personId,
        type: "text",
        values: { valueText: "Wrong tenant" },
      }),
    ).rejects.toMatchObject({ code: "23503" });
  });

  it("rejects nonexistent and cross-organization resource-grant members", async () => {
    const first = await seedWorkspace("grant-a");
    const second = await seedWorkspace("grant-b");
    const policyId = newId();
    await db()`
      INSERT INTO access_policies (
        id, workspace_id, name, created_by, updated_by
      ) VALUES (
        ${policyId}, ${first.workspaceId}, 'Policy', ${first.userId}, ${first.userId}
      )
    `;

    const insertGrant = (memberId: string) => db()`
      INSERT INTO resource_grants (
        id,
        workspace_id,
        policy_id,
        member_id,
        resource_id,
        resource_kind,
        created_by,
        updated_by
      ) VALUES (
        ${newId()},
        ${first.workspaceId},
        ${policyId},
        ${memberId},
        ${newId()},
        'person',
        ${first.userId},
        ${first.userId}
      )
    `;

    await expect(insertGrant(`missing-${newId()}`)).rejects.toMatchObject({
      code: "23503",
    });
    await expect(insertGrant(second.memberId)).rejects.toMatchObject({
      code: "23503",
    });
    await expect(insertGrant(first.memberId)).resolves.toBeDefined();
  });

  it("HUM-FR-009 matches selections to the fact namespace and field key", async () => {
    const fixture = await seedWorkspace("selection");
    const firstDefinition = await seedDefinition(
      fixture,
      "text",
      "core",
      "occupation",
    );
    const secondDefinition = await seedDefinition(
      fixture,
      "text",
      "research",
      "occupation",
    );
    const firstFactId = await insertFact({
      definition: firstDefinition,
      fixture,
      type: "text",
      values: { valueText: "Researcher" },
    });
    const secondFactId = await insertFact({
      definition: secondDefinition,
      fixture,
      type: "text",
      values: { valueText: "Engineer" },
    });
    const insertSelection = (
      namespace: string,
      fieldKey: string,
      factId: string,
    ) =>
      db()`
        INSERT INTO person_field_selections (
          id,
          workspace_id,
          person_id,
          namespace,
          field_key,
          fact_id,
          selected_by,
          created_by,
          updated_by
        ) VALUES (
          ${newId()},
          ${fixture.workspaceId},
          ${fixture.personId},
          ${namespace},
          ${fieldKey},
          ${factId},
          ${fixture.userId},
          ${fixture.userId},
          ${fixture.userId}
        )
      `;

    await expect(
      insertSelection("core", "wrong-field", firstFactId),
    ).rejects.toMatchObject({ code: "23503" });
    await expect(
      insertSelection("research", "occupation", firstFactId),
    ).rejects.toMatchObject({ code: "23503" });
    await expect(
      insertSelection("core", "occupation", firstFactId),
    ).resolves.toBeDefined();
    await expect(
      insertSelection("research", "occupation", secondFactId),
    ).resolves.toBeDefined();
  });

  it("HUM-FR-012 accepts every approved fact value type", async () => {
    const fixture = await seedWorkspace("typed-positive");

    for (const type of factValueTypes) {
      const definition = await seedDefinition(fixture, type);
      await expect(
        insertFact({
          definition,
          fixture,
          type,
          values: validValues(type, fixture),
        }),
      ).resolves.toBeDefined();
    }
  });

  it("HUM-FR-012 rejects an invalid representation for every fact value type", async () => {
    const fixture = await seedWorkspace("typed-negative");

    for (const type of factValueTypes) {
      const definition = await seedDefinition(fixture, type);
      await expect(
        insertFact({
          definition,
          fixture,
          type,
          values: invalidValues(type),
        }),
      ).rejects.toMatchObject({ code: "23514" });
    }
  });

  it("HUM-FR-012 permits unit only for duration and quantity", async () => {
    const fixture = await seedWorkspace("typed-unit");

    for (const type of factValueTypes.filter(
      (candidate) => candidate !== "duration" && candidate !== "quantity",
    )) {
      const definition = await seedDefinition(fixture, type);
      await expect(
        insertFact({
          definition,
          fixture,
          type,
          values: { ...validValues(type, fixture), unit: "forbidden" },
        }),
      ).rejects.toMatchObject({ code: "23514" });
    }

    for (const type of ["duration", "quantity"] as const) {
      const definition = await seedDefinition(fixture, type);
      await expect(
        insertFact({
          definition,
          fixture,
          type,
          values: { valueDecimal: "1" },
        }),
      ).rejects.toMatchObject({ code: "23514" });
    }
  });

  it("HUM-FR-013 keeps fact revisions insert-only and prevents parent hard deletion", async () => {
    const fixture = await seedWorkspace("revision");
    const definition = await seedDefinition(fixture, "text");
    const factId = await insertFact({
      definition,
      fixture,
      type: "text",
      values: { valueText: "Original" },
    });
    const revisionId = newId();

    await db()`
      INSERT INTO fact_revisions (
        id,
        workspace_id,
        fact_id,
        revision,
        after_snapshot,
        created_by
      ) VALUES (
        ${revisionId},
        ${fixture.workspaceId},
        ${factId},
        1,
        ${JSON.stringify({ value: "Original" })},
        ${fixture.userId}
      )
    `;

    await expect(
      db()`UPDATE fact_revisions SET change_reason = 'changed' WHERE id = ${revisionId}`,
    ).rejects.toMatchObject({ code: "55000" });
    await expect(
      db()`DELETE FROM fact_revisions WHERE id = ${revisionId}`,
    ).rejects.toMatchObject({ code: "55000" });
    await expect(
      db()`DELETE FROM facts WHERE id = ${factId}`,
    ).rejects.toMatchObject({ code: "23001" });
  });

  it("HUM-FR-013 rejects immediate, two-node, and three-node supersession cycles", async () => {
    const fixture = await seedWorkspace("supersession");
    const definition = await seedDefinition(fixture, "text");
    const selfId = newId();

    await expect(
      insertFact({
        definition,
        fixture,
        id: selfId,
        supersedesFactId: selfId,
        type: "text",
        values: { valueText: "Self" },
      }),
    ).rejects.toMatchObject({ code: "23514" });

    const firstId = await insertFact({
      definition,
      fixture,
      type: "text",
      values: { valueText: "First" },
    });
    const secondId = await insertFact({
      definition,
      fixture,
      supersedesFactId: firstId,
      type: "text",
      values: { valueText: "Second" },
    });
    await expect(
      db()`UPDATE facts SET supersedes_fact_id = ${secondId} WHERE id = ${firstId}`,
    ).rejects.toMatchObject({ code: "23514" });

    const thirdId = await insertFact({
      definition,
      fixture,
      supersedesFactId: secondId,
      type: "text",
      values: { valueText: "Third" },
    });
    await expect(
      db()`UPDATE facts SET supersedes_fact_id = ${thirdId} WHERE id = ${firstId}`,
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("HUM-FR-013 serializes concurrent opposite supersession updates", async () => {
    const fixture = await seedWorkspace("supersession-concurrent");
    const definition = await seedDefinition(fixture, "text");
    const firstId = await insertFact({
      definition,
      fixture,
      type: "text",
      values: { valueText: "First" },
    });
    const secondId = await insertFact({
      definition,
      fixture,
      type: "text",
      values: { valueText: "Second" },
    });
    const firstConnection = postgres(databaseUrl!, {
      max: 1,
      prepare: false,
    });
    const secondConnection = postgres(databaseUrl!, {
      max: 1,
      prepare: false,
    });
    const [{ pid: secondPid }] = await secondConnection<[{ pid: number }]>`
      SELECT pg_backend_pid() AS pid
    `;
    let firstTransactionOpen = false;
    let secondTransactionOpen = false;

    try {
      await firstConnection`BEGIN`;
      firstTransactionOpen = true;
      await secondConnection`BEGIN`;
      secondTransactionOpen = true;
      await firstConnection`
        UPDATE facts
        SET supersedes_fact_id = ${secondId}
        WHERE id = ${firstId}
      `;

      let secondOutcome:
        | { error: unknown; status: "rejected" }
        | { status: "fulfilled" }
        | { status: "pending" } = { status: "pending" };
      const secondUpdate = secondConnection`
        UPDATE facts
        SET supersedes_fact_id = ${firstId}
        WHERE id = ${secondId}
      `.then(
        () => {
          secondOutcome = { status: "fulfilled" };
          return secondOutcome;
        },
        (error: unknown) => {
          secondOutcome = { error, status: "rejected" };
          return secondOutcome;
        },
      );

      let observedLockWait = false;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const [activity] = await db()<[{ wait_event_type: string | null }]>`
          SELECT wait_event_type
          FROM pg_stat_activity
          WHERE pid = ${secondPid}
        `;
        if (activity?.wait_event_type === "Lock") {
          observedLockWait = true;
          break;
        }
        if (secondOutcome.status !== "pending") break;
        await delay(10);
      }

      expect(observedLockWait).toBe(true);
      expect(secondOutcome.status).toBe("pending");

      await firstConnection`COMMIT`;
      firstTransactionOpen = false;
      const result = await secondUpdate;

      expect(result.status).toBe("rejected");
      if (result.status === "rejected") {
        expect(result.error).toMatchObject({ code: "23514" });
      }
    } finally {
      if (firstTransactionOpen) await firstConnection`ROLLBACK`;
      if (secondTransactionOpen) await secondConnection`ROLLBACK`;
      await firstConnection.end();
      await secondConnection.end();
    }
  });
});
