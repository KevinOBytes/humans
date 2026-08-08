// @vitest-environment node

import { createHash, createHmac } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { Readable } from "node:stream";

import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres, { type Sql, type TransactionSql } from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { newId } from "@/db/id";
import * as schema from "@/db/schema";
import { importRows, imports, jobs } from "@/db/schema";
import type { ObjectStore } from "@/lib/storage/types";
import { createImportsService } from "@/modules/imports/service";
import { disabledSearchIndexMaintenance } from "@/modules/search/index-maintenance";

import { assertTestDatabaseResetAllowed } from "../support/database-reset-guard";

const databaseUrl = process.env.TEST_DATABASE_URL;
const resetAllowed = process.env.ALLOW_TEST_DATABASE_RESET;
const liveDescribe = databaseUrl ? describe : describe.skip;
const encryptionKey = "93".repeat(32);
const prerequisites = [
  "drizzle/0000_core.sql",
  "drizzle/0001_task4_invariants.sql",
  "drizzle/0002_core.sql",
  "drizzle/0003_task5_corrective.sql",
  "drizzle/0004_task6_auth.sql",
  "drizzle/0005_task11_upload_session_metadata.sql",
  "drizzle/0006_task11_import_job_lifecycle.sql",
] as const;
const remainingMigrations = readdirSync("drizzle")
  .filter((name) => /^\d{4}_.+\.sql$/u.test(name))
  .filter((name) => Number.parseInt(name.slice(0, 4), 10) > 7)
  .sort()
  .map((name) => `drizzle/${name}`);

function withDatabase(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

async function applyMigrationFile(
  sql: Sql | TransactionSql,
  path: string,
): Promise<void> {
  const statements = readFileSync(path, "utf8")
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter(Boolean);
  for (const statement of statements) await sql.unsafe(statement);
}

function canonicalJson(value: unknown): string {
  if (value === null || ["boolean", "string"].includes(typeof value)) {
    return JSON.stringify(value);
  }
  if (typeof value === "number") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (!value || typeof value !== "object") throw new TypeError("invalid");
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
    .join(",")}}`;
}

function keyedHash(purpose: string, value: unknown): string {
  return createHmac("sha256", Buffer.from(encryptionKey, "hex"))
    .update(`humans:${purpose}:v1\0`, "utf8")
    .update(canonicalJson(value), "utf8")
    .digest("hex");
}

liveDescribe("Task 11 import lifecycle forward migration", () => {
  const temporaryDatabase = `humans_import_upgrade_${newId().replaceAll("-", "")}`;
  let admin: Sql;
  let upgrade: Sql;

  beforeAll(async () => {
    if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required");
    const currentDatabase = new URL(databaseUrl).pathname.slice(1);
    assertTestDatabaseResetAllowed({
      allowReset: resetAllowed,
      currentDatabase,
      databaseUrl,
    });
    admin = postgres(withDatabase(databaseUrl, "postgres"), {
      max: 1,
      onnotice: () => undefined,
      prepare: false,
    });
    await admin.unsafe(`CREATE DATABASE "${temporaryDatabase}"`);
    upgrade = postgres(withDatabase(databaseUrl, temporaryDatabase), {
      max: 4,
      onnotice: () => undefined,
      prepare: false,
    });
    for (const migration of prerequisites) {
      await applyMigrationFile(upgrade, migration);
    }
  }, 120_000);

  afterAll(async () => {
    await upgrade?.end();
    if (admin) {
      await admin.unsafe(
        `DROP DATABASE IF EXISTS "${temporaryDatabase}" WITH (FORCE)`,
      );
      await admin.end();
    }
  }, 120_000);

  it("reconciles every valid legacy import state and preserves public recovery contracts", async () => {
    const organizationId = `legacy-import-org-${newId()}`;
    const userId = `legacy-import-user-${newId()}`;
    const memberId = `legacy-import-member-${newId()}`;
    const workspaceId = newId();
    const principalId = newId();
    const sessionId = `migration-session-${newId()}`;
    const fileId = newId();
    const mappingId = newId();
    const importIds = {
      completed: newId(),
      completed_with_errors: newId(),
      dead_letter: newId(),
      failed: newId(),
      linkedRetry: newId(),
      pending: newId(),
      preview_ready: newId(),
      queued: newId(),
      running: newId(),
      staging: newId(),
    };
    const linkedJobId = newId();
    const existingTombstoneId = newId();
    const definition = {
      version: 1,
      recordKind: "PERSON",
      rowKeySource: "external_id",
      person: {
        displayNameSource: "name",
        primaryNameKind: "legal",
        fields: [],
      },
      facts: [],
      defaults: {},
    } as const;
    const checksum = `sha256:${"81".repeat(32)}`;
    const mappingHash = createHash("sha256")
      .update(canonicalJson(definition))
      .digest("hex");
    const mapping = {
      definition,
      mappingHash,
      mappingId,
      mappingVersion: 1,
      mode: "COMMIT",
      requestHash: "82".repeat(32),
    } as const;
    const rawStagingKey = "resume-interrupted-legacy-prepare";
    const stagingIdempotencyKey = keyedHash("import-prepare-key", {
      actorId: userId,
      key: rawStagingKey,
      workspaceId,
    });
    const stagingMapping = {
      ...mapping,
      requestHash: keyedHash("import-prepare-request", {
        actorId: userId,
        fileChecksum: checksum,
        fileSize: 10,
        mappingHash,
        mappingId,
        mappingVersion: 1,
        mode: "COMMIT",
        workspaceId,
      }),
    } as const;

    await upgrade`
      INSERT INTO users (id, name, email, username, email_verified, created_at, updated_at)
      VALUES (${userId}, 'Legacy Import User', ${`${newId()}@example.test`}, ${`legacy_${newId().replaceAll("-", "")}`}, true, now(), now())
    `;
    await upgrade`
      INSERT INTO organizations (id, name, slug, created_at)
      VALUES (${organizationId}, 'Legacy Import Organization', ${`legacy-import-${newId()}`}, now())
    `;
    await upgrade`
      INSERT INTO workspaces (id, organization_id, name, created_by, updated_by)
      VALUES (${workspaceId}, ${organizationId}, 'Legacy Import Workspace', ${userId}, ${userId})
    `;
    await upgrade`
      INSERT INTO members (id, organization_id, user_id, role, created_at, workspace_id)
      VALUES (${memberId}, ${organizationId}, ${userId}, 'owner', now(), ${workspaceId})
    `;
    await upgrade`
      INSERT INTO sessions (
        id, expires_at, token, created_at, updated_at, user_id,
        active_organization_id
      ) VALUES (
        ${sessionId}, now() + interval '1 day', ${`token-${newId()}`},
        now(), now(), ${userId}, ${organizationId}
      )
    `;
    await upgrade`
      INSERT INTO workspace_principals (id, workspace_id, principal_type, user_id, member_id_snapshot)
      VALUES (${principalId}, ${workspaceId}, 'user', ${userId}, ${memberId})
    `;
    await upgrade`
      INSERT INTO files (
        id, workspace_id, storage_provider, storage_bucket, storage_key,
        original_name, media_type, detected_type, byte_size, checksum,
        quarantine_state, scan_state, ocr_state, extraction_state,
        uploaded_by, created_by, updated_by
      ) VALUES (
        ${fileId}, ${workspaceId}, 'minio', 'private', ${`legacy-import/${fileId}`},
        'legacy.csv', 'text/csv', 'text/csv', 10, 'legacy-invalid-checksum',
        'available', 'not_required', 'not_requested', 'not_requested',
        ${userId}, ${userId}, ${userId}
      )
    `;
    await upgrade`
      INSERT INTO import_mappings (
        id, workspace_id, name, format, column_mapping, validation_config,
        version, created_by, updated_by
      ) VALUES (
        ${mappingId}, ${workspaceId}, 'Legacy people', 'CSV',
        ${upgrade.json(definition)}, '{}'::jsonb, 1, ${userId}, ${userId}
      )
    `;
    await upgrade`
      INSERT INTO upload_sessions (
        id, workspace_id, actor_id, intended_purpose, original_name,
        max_bytes, expected_checksum, expected_media_type, object_key,
        state, expires_at, completed_at, file_id, created_by, updated_by
      ) VALUES (
        ${newId()}, ${workspaceId}, ${userId}, 'CSV_IMPORT', 'legacy.csv',
        10, ${checksum}, 'text/csv', ${`legacy-import/${fileId}`},
        'completed', now() + interval '1 day', now(), ${fileId}, ${userId}, ${userId}
      )
    `;
    for (const [state, importId] of Object.entries(importIds)) {
      if (state === "linkedRetry") continue;
      await upgrade`
        INSERT INTO imports (
          id, workspace_id, file_id, format, state, mapping, idempotency_key,
          total_rows, accepted_rows, rejected_rows, started_at, completed_at,
          created_by, updated_by
        ) VALUES (
          ${importId}, ${workspaceId}, ${fileId}, 'CSV', ${state},
          ${upgrade.json(state === "staging" ? stagingMapping : mapping)},
          ${state === "staging" ? stagingIdempotencyKey : `legacy-${state}-${importId}`}, 1,
          ${state === "completed" ? 1 : 0},
          ${state === "completed_with_errors" ? 1 : 0},
          ${["running", "failed", "dead_letter"].includes(state) ? new Date() : null},
          ${["completed", "completed_with_errors"].includes(state) ? new Date() : null},
          ${userId}, ${userId}
        )
      `;
      await upgrade`
        INSERT INTO import_rows (
          id, workspace_id, import_id, row_number, source_hash,
          normalized_payload, state, created_by, updated_by
        ) VALUES (
          ${newId()}, ${workspaceId}, ${importId}, 1, ${"83".repeat(32)},
          ${upgrade.json({
            kind: "PERSON",
            rowKey: `legacy-${state}`,
            person: { displayName: `Legacy ${state}` },
            primaryNameKind: "legal",
            facts: [],
            defaults: {},
          })}, ${state === "completed" ? "succeeded" : state === "completed_with_errors" ? "rejected" : ["running", "failed", "dead_letter"].includes(state) ? "processing" : "pending"}, ${userId}, ${userId}
        )
      `;
    }
    await upgrade`
      INSERT INTO jobs (
        id, workspace_id, kind, encrypted_payload, payload_hash,
        idempotency_key, state, result_references
      ) VALUES (
        ${linkedJobId}, ${workspaceId}, 'import_execute',
        'legacy:completed-import', ${`sha256:${"84".repeat(32)}`},
        ${`legacy-linked-job:${linkedJobId}`}, 'completed', '[]'::jsonb
      )
    `;
    await upgrade`
      INSERT INTO imports (
        id, workspace_id, file_id, format, state, mapping, idempotency_key,
        execution_job_id, total_rows, rejected_rows, completed_at,
        created_by, updated_by
      ) VALUES (
        ${importIds.linkedRetry}, ${workspaceId}, ${fileId}, 'CSV',
        'completed_with_errors', ${upgrade.json(mapping)},
        ${`legacy-linked-import:${importIds.linkedRetry}`}, ${linkedJobId},
        1, 1, now(), ${userId}, ${userId}
      )
    `;
    await upgrade`
      INSERT INTO import_rows (
        id, workspace_id, import_id, row_number, source_hash,
        normalized_payload, validation_errors, state, created_by, updated_by
      ) VALUES (
        ${newId()}, ${workspaceId}, ${importIds.linkedRetry}, 1,
        ${"85".repeat(32)}, ${upgrade.json({
          kind: "PERSON",
          rowKey: "legacy-linked-retry",
          person: { displayName: "Legacy linked retry" },
          primaryNameKind: "legal",
          facts: [],
          defaults: {},
        })}, ${upgrade.json([
          { code: "ROW_VALIDATION_FAILED", message: "legacy rejection" },
        ])}, 'rejected', ${userId}, ${userId}
      )
    `;
    await upgrade`
      INSERT INTO jobs (
        id, workspace_id, kind, encrypted_payload, payload_hash,
        idempotency_key, state, error_code, result_references
      ) VALUES (
        ${existingTombstoneId}, ${workspaceId}, 'import_execute',
        'migration:tombstone', ${`sha256:${"0".repeat(64)}`},
        ${`legacy-import-tombstone:${importIds.pending}`}, 'dead_letter',
        'legacy_import_reconciled', '[]'::jsonb
      )
    `;

    await expect(
      upgrade.begin((transaction) =>
        applyMigrationFile(
          transaction,
          "drizzle/0007_task11_review_repairs.sql",
        ),
      ),
    ).rejects.toThrow(/missing or invalid file snapshot dependency/u);
    await upgrade`
      UPDATE files SET checksum = ${checksum}
      WHERE workspace_id = ${workspaceId} AND id = ${fileId}
    `;
    await expect(
      upgrade.begin((transaction) =>
        applyMigrationFile(
          transaction,
          "drizzle/0007_task11_review_repairs.sql",
        ),
      ),
    ).resolves.toBeUndefined();

    const normalized = await upgrade<
      {
        execution_job_id: string;
        id: string;
        mapping: { fileChecksum?: string; fileSize?: number };
        state: string;
        version: number;
      }[]
    >`
      SELECT id, execution_job_id, mapping, state, version
      FROM imports
      WHERE workspace_id = ${workspaceId}
      ORDER BY id
    `;
    expect(normalized).toHaveLength(10);
    const reconciledIds = [
      importIds.pending,
      importIds.preview_ready,
      importIds.queued,
      importIds.running,
      importIds.completed_with_errors,
      importIds.failed,
      importIds.dead_letter,
    ];
    expect(
      normalized
        .filter(({ id }) => reconciledIds.includes(id))
        .every(
          ({ execution_job_id, state }) =>
            execution_job_id !== null && state === "dead_letter",
        ),
    ).toBe(true);
    expect(normalized.find(({ id }) => id === importIds.staging)).toMatchObject(
      { execution_job_id: null, state: "staging" },
    );
    expect(
      normalized.find(({ id }) => id === importIds.linkedRetry),
    ).toMatchObject({
      execution_job_id: linkedJobId,
      state: "completed_with_errors",
    });
    expect(
      normalized.find(({ id }) => id === importIds.completed),
    ).toMatchObject({ execution_job_id: null, state: "completed", version: 1 });
    expect(
      normalized.every(
        ({ mapping: stored }) =>
          stored.fileChecksum === checksum && stored.fileSize === 10,
      ),
    ).toBe(true);
    expect(
      normalized.find(({ id }) => id === importIds.pending)?.execution_job_id,
    ).toBe(existingTombstoneId);
    for (const id of reconciledIds.filter((id) => id !== importIds.pending)) {
      expect(normalized.find((row) => row.id === id)?.execution_job_id).toBe(
        id,
      );
    }
    const migrationAudits = await upgrade<{ id: string }[]>`
      SELECT id FROM audit_events
      WHERE workspace_id = ${workspaceId}
        AND action = 'import.migration_dead_lettered'
    `;
    expect(new Set(migrationAudits.map(({ id }) => id))).toEqual(
      new Set(reconciledIds),
    );

    for (const migration of remainingMigrations) {
      await applyMigrationFile(upgrade, migration);
    }

    const database = drizzle(upgrade, { schema });
    const csvBody = Buffer.from(
      "external_id,name\nlegacy-staging,Recovered legacy staging\n",
    );
    const objectStore: ObjectStore = {
      async createUpload() {
        throw new Error("not used");
      },
      async createDownload() {
        throw new Error("not used");
      },
      async checkReachability() {},
      async getMetadata() {
        return null;
      },
      async openRead() {
        return { body: Readable.from([csvBody]), bytes: csvBody.byteLength };
      },
      async exists() {
        return true;
      },
      async delete() {},
    };
    const serviceContext = {
      actor: {
        type: "user" as const,
        id: userId,
        memberId,
        principalId,
        role: "owner",
        sessionId,
      },
      database,
      operationLimiter: {
        consume: async () => ({
          allowed: true,
          remainingMicrotokens: 1,
          retryAfterMs: 0,
        }),
      },
      permissions: new Set([
        "import:create",
        "import:read",
        "import:run",
        "person:create",
        "fact:create",
      ]),
      requestId: newId(),
      searchIndexMaintenance: disabledSearchIndexMaintenance,
      workspaceId,
    };
    const recovered = await createImportsService(serviceContext, {
      encryptionKey,
      objectStore,
    }).prepareImport({
      fileId,
      mappingId,
      idempotencyKey: rawStagingKey,
      mode: "COMMIT",
    });
    expect(recovered.import).toMatchObject({
      id: importIds.staging,
      stagingGeneration: 1,
      state: "preview_ready",
    });
    expect(recovered.preview).toHaveLength(1);

    const service = createImportsService(serviceContext, { encryptionKey });
    for (const [index, importId] of [
      ...reconciledIds,
      importIds.linkedRetry,
    ].entries()) {
      const [candidate] = await database
        .select()
        .from(imports)
        .where(eq(imports.id, importId));
      const retried = await service.retryImport({
        importId,
        expectedVersion: candidate!.version,
        idempotencyKey: `post-upgrade-retry-${index}`,
      });
      expect(retried.import).toMatchObject({ state: "queued" });
      expect(retried.job).toMatchObject({
        kind: "import_execute",
        state: "queued",
      });
      expect(retried.job.requestHash).toMatch(/^sha256:[0-9a-f]{64}$/u);
      if (importId === importIds.completed_with_errors) {
        const [resetRow] = await database
          .select({ state: importRows.state })
          .from(importRows)
          .where(eq(importRows.importId, importId));
        expect(resetRow).toEqual({ state: "pending" });
      }
      await database
        .update(imports)
        .set({ state: "dead_letter" })
        .where(eq(imports.id, importId));
    }
    const [completed] = await database
      .select()
      .from(imports)
      .where(eq(imports.id, importIds.completed));
    await expect(
      service.retryImport({
        importId: importIds.completed,
        expectedVersion: completed!.version,
        idempotencyKey: "completed-is-terminal",
      }),
    ).rejects.toMatchObject({ extensions: { code: "CONFLICT" } });
    const tombstones = await database
      .select()
      .from(jobs)
      .where(eq(jobs.errorCode, "legacy_import_reconciled"));
    expect(tombstones).toHaveLength(reconciledIds.length);
  }, 120_000);
});
