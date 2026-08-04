// @vitest-environment node

import { readFileSync, readdirSync } from "node:fs";
import postgres, { type Sql } from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { newId } from "@/db/id";
import { assertTestDatabaseResetAllowed } from "../support/database-reset-guard";

const databaseUrl = process.env.TEST_DATABASE_URL;
const resetAllowed = process.env.ALLOW_TEST_DATABASE_RESET;
const liveDescribe = databaseUrl || resetAllowed ? describe : describe.skip;

const migrationFiles = [
  "drizzle/0000_core.sql",
  "drizzle/0001_task4_invariants.sql",
  "drizzle/0002_core.sql",
] as const;

const task11PrerequisiteMigrationFiles = [
  "drizzle/0000_core.sql",
  "drizzle/0001_task4_invariants.sql",
  "drizzle/0002_core.sql",
  "drizzle/0003_task5_corrective.sql",
  "drizzle/0004_task6_auth.sql",
] as const;

const task12PrerequisiteMigrationFiles = [
  "drizzle/0000_core.sql",
  "drizzle/0001_task4_invariants.sql",
  "drizzle/0002_core.sql",
  "drizzle/0003_task5_corrective.sql",
  "drizzle/0004_task6_auth.sql",
  "drizzle/0005_task11_upload_session_metadata.sql",
  "drizzle/0006_task11_import_job_lifecycle.sql",
  "drizzle/0007_task11_review_repairs.sql",
] as const;

const throughTask13MigrationFiles = readdirSync("drizzle")
  .filter((name) => /^\d{4}_.+\.sql$/u.test(name))
  .filter((name) => Number(name.slice(0, 4)) <= 18)
  .sort()
  .map((name) => `drizzle/${name}`);

const withDatabase = (url: string, database: string) => {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
};

async function applyMigrationFile(sql: Sql, path: string): Promise<void> {
  const statements = readFileSync(path, "utf8")
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter(Boolean);

  for (const statement of statements) await sql.unsafe(statement);
}

async function cleanupTemporaryDatabase(input: {
  admin: Sql | undefined;
  database: string;
  upgrade: Sql | undefined;
}): Promise<void> {
  await input.upgrade?.end({ timeout: 5 });
  if (!input.admin) return;
  await input.admin.unsafe("SET statement_timeout = '20s'");
  await input.admin.unsafe(
    `DROP DATABASE IF EXISTS "${input.database}" WITH (FORCE)`,
  );
  await input.admin.end({ timeout: 5 });
}

liveDescribe("Task 5 forward migration on PostgreSQL 18", () => {
  const temporaryDatabase = `humans_upgrade_${newId().replaceAll("-", "")}`;
  let admin: Sql | undefined;
  let upgrade: Sql | undefined;

  beforeAll(async () => {
    if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required");
    const parsed = new URL(databaseUrl);
    const currentDatabase = parsed.pathname.slice(1);
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
      max: 1,
      onnotice: () => undefined,
      prepare: false,
    });
  });

  afterAll(
    () =>
      cleanupTemporaryDatabase({
        admin,
        database: temporaryDatabase,
        upgrade,
      }),
    30_000,
  );

  it("remediates cross-thread citations and organization API keys without workspaces", async () => {
    if (!upgrade) throw new Error("upgrade connection was not initialized");
    for (const path of migrationFiles) await applyMigrationFile(upgrade, path);

    const workspaceId = newId();
    const threadA = newId();
    const threadB = newId();
    const messageA = newId();
    const messageB = newId();
    const runId = newId();
    const citationId = newId();
    const apiKeyId = `legacy-key-${newId()}`;

    await upgrade`
      INSERT INTO organizations (id, name, slug, created_at)
      VALUES
        ('legacy-org-with-workspace', 'Legacy Workspace Org', ${`legacy-workspace-${newId()}`}, now()),
        ('legacy-org-without-workspace', 'Legacy Orphan Org', ${`legacy-orphan-${newId()}`}, now())
    `;
    await upgrade`
      INSERT INTO workspaces (id, organization_id, name, created_by, updated_by)
      VALUES (${workspaceId}, 'legacy-org-with-workspace', 'Legacy Workspace', 'legacy-user', 'legacy-user')
    `;
    await upgrade`
      INSERT INTO ai_threads (id, workspace_id, owner_id, title, created_by, updated_by)
      VALUES
        (${threadA}, ${workspaceId}, 'legacy-user', 'Thread A', 'legacy-user', 'legacy-user'),
        (${threadB}, ${workspaceId}, 'legacy-user', 'Thread B', 'legacy-user', 'legacy-user')
    `;
    await upgrade`
      INSERT INTO ai_messages (
        id, workspace_id, thread_id, role, encrypted_content, content_hash,
        created_by, updated_by
      ) VALUES
        (${messageA}, ${workspaceId}, ${threadA}, 'user', 'encrypted:a', 'sha256:a', 'legacy-user', 'legacy-user'),
        (${messageB}, ${workspaceId}, ${threadB}, 'assistant', 'encrypted:b', 'sha256:b', 'legacy-user', 'legacy-user')
    `;
    await upgrade`
      INSERT INTO ai_runs (
        id, workspace_id, thread_id, message_id, provider,
        base_url_fingerprint, model, prompt_hash, configuration_hash, created_by
      ) VALUES (
        ${runId}, ${workspaceId}, ${threadA}, ${messageB}, 'legacy',
        'base', 'model', 'prompt', 'configuration', 'legacy-user'
      )
    `;
    await upgrade`
      INSERT INTO ai_citations (
        id, workspace_id, ai_run_id, message_id, resource_kind, resource_id,
        claim_text
      ) VALUES (
        ${citationId}, ${workspaceId}, ${runId}, ${messageB}, 'person',
        ${newId()}, 'Legacy cross-thread citation'
      )
    `;
    await upgrade`
      INSERT INTO api_keys (
        id, config_id, reference_id, key, created_at, updated_at
      ) VALUES (
        ${apiKeyId}, 'organization', 'legacy-org-without-workspace',
        ${`hashed-${newId()}`}, now(), now()
      )
    `;

    await expect(
      applyMigrationFile(upgrade, "drizzle/0003_task5_corrective.sql"),
    ).resolves.toBeUndefined();

    const [citation] = await upgrade<
      [
        {
          legacy_message_id: string;
          message_id: string | null;
          thread_id: string;
        },
      ]
    >`
      SELECT thread_id, message_id, legacy_message_id
      FROM ai_citations
      WHERE id = ${citationId}
    `;
    expect(citation).toEqual({
      legacy_message_id: messageB,
      message_id: null,
      thread_id: threadA,
    });
    await expect(
      upgrade`
        UPDATE ai_citations
        SET legacy_message_id = ${newId()}
        WHERE id = ${citationId}
      `,
    ).rejects.toMatchObject({ code: "55000" });
    const [preservedCitation] = await upgrade<
      [{ legacy_message_id: string; message_id: string | null }]
    >`
      SELECT legacy_message_id, message_id
      FROM ai_citations
      WHERE id = ${citationId}
    `;
    expect(preservedCitation).toEqual({
      legacy_message_id: messageB,
      message_id: null,
    });

    const [run] = await upgrade<
      [
        {
          capability_profile: { migration: { legacyMessageId: string } };
          message_id: string | null;
        },
      ]
    >`
      SELECT capability_profile, message_id
      FROM ai_runs
      WHERE id = ${runId}
    `;
    expect(run).toEqual({
      capability_profile: {
        migration: { legacyMessageId: messageB },
      },
      message_id: null,
    });

    const [apiKey] = await upgrade<
      [{ workspace_id: string; workspace_name: string }]
    >`
      SELECT api_key.workspace_id, workspace.name AS workspace_name
      FROM api_keys AS api_key
      JOIN workspaces AS workspace ON workspace.id = api_key.workspace_id
      WHERE api_key.id = ${apiKeyId}
    `;
    expect(apiKey.workspace_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(apiKey.workspace_name).toBe("Legacy Orphan Org");
  }, 120_000);

  it("remediates legacy auth roles and fails unsupported roles with an actionable error", async () => {
    if (!upgrade) throw new Error("upgrade connection was not initialized");
    const organizationId = `legacy-role-org-${newId()}`;
    const workspaceId = newId();
    const ownerId = `legacy-owner-${newId()}`;
    const memberId = `legacy-member-${newId()}`;

    await upgrade`
      INSERT INTO users (
        id, name, email, email_verified, created_at, updated_at, role
      ) VALUES
        (${ownerId}, 'Legacy Owner', ${`${newId()}@example.test`}, true, now(), now(), 'user'),
        (${memberId}, 'Legacy Member', ${`${newId()}@example.test`}, true, now(), now(), 'superadmin')
    `;
    await upgrade`
      INSERT INTO organizations (id, name, slug, created_at)
      VALUES (${organizationId}, 'Legacy Roles', ${`legacy-roles-${newId()}`}, now())
    `;
    await upgrade`
      INSERT INTO workspaces (id, organization_id, name, created_by, updated_by)
      VALUES (${workspaceId}, ${organizationId}, 'Legacy Roles', ${ownerId}, ${ownerId})
    `;
    await upgrade`
      INSERT INTO members (
        id, organization_id, user_id, role, created_at, workspace_id
      ) VALUES (
        ${`legacy-membership-${newId()}`}, ${organizationId}, ${memberId},
        'member', now(), ${workspaceId}
      )
    `;
    await upgrade`
      INSERT INTO invitations (
        id, organization_id, email, role, status, expires_at, created_at, inviter_id
      ) VALUES (
        ${`legacy-invitation-${newId()}`}, ${organizationId},
        ${`${newId()}@example.test`}, 'member', 'pending', now() + interval '1 day',
        now(), ${ownerId}
      )
    `;

    await expect(
      applyMigrationFile(upgrade, "drizzle/0004_task6_auth.sql"),
    ).rejects.toThrow(/users contain unsupported global roles/i);

    await upgrade`UPDATE users SET role = NULL WHERE id = ${memberId}`;
    await expect(
      applyMigrationFile(upgrade, "drizzle/0004_task6_auth.sql"),
    ).resolves.toBeUndefined();

    const [remediated] = await upgrade<
      [
        {
          invitation_role: string;
          member_role: string;
          member_role_default: string;
          user_role_default: string;
        },
      ]
    >`
      SELECT
        (SELECT role FROM invitations WHERE organization_id = ${organizationId}) AS invitation_role,
        (SELECT role FROM members WHERE organization_id = ${organizationId}) AS member_role,
        (
          SELECT column_default
          FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name = 'members'
            AND column_name = 'role'
        ) AS member_role_default,
        (
          SELECT column_default
          FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name = 'users'
            AND column_name = 'role'
        ) AS user_role_default
    `;
    expect(remediated).toEqual({
      invitation_role: "viewer",
      member_role: "viewer",
      member_role_default: "'viewer'::text",
      user_role_default: "'user'::text",
    });

    const constraints = await upgrade<{ constraint_name: string }[]>`
      SELECT constraint_name
      FROM information_schema.table_constraints
      WHERE table_schema = 'public'
        AND constraint_name IN (
          'users_global_role_check',
          'members_workspace_role_check',
          'invitations_workspace_role_check'
        )
      ORDER BY constraint_name
    `;
    expect(constraints.map(({ constraint_name }) => constraint_name)).toEqual([
      "invitations_workspace_role_check",
      "members_workspace_role_check",
      "users_global_role_check",
    ]);

    await expect(
      upgrade`
        UPDATE members
        SET role = 'member'
        WHERE organization_id = ${organizationId}
      `,
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      upgrade`
        UPDATE invitations
        SET role = 'member'
        WHERE organization_id = ${organizationId}
      `,
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      upgrade`
        UPDATE users
        SET role = 'superadmin'
        WHERE id = ${memberId}
      `,
    ).rejects.toMatchObject({ code: "23514" });
  }, 120_000);
});

liveDescribe(
  "Task 11 upload metadata forward migration on PostgreSQL 18",
  () => {
    const temporaryDatabase = `humans_upload_upgrade_${newId().replaceAll("-", "")}`;
    let admin: Sql | undefined;
    let upgrade: Sql | undefined;

    beforeAll(async () => {
      if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required");
      const parsed = new URL(databaseUrl);
      const currentDatabase = parsed.pathname.slice(1);
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
        max: 1,
        onnotice: () => undefined,
        prepare: false,
      });
      for (const path of task11PrerequisiteMigrationFiles) {
        await applyMigrationFile(upgrade, path);
      }
    }, 120_000);

    afterAll(
      () =>
        cleanupTemporaryDatabase({
          admin,
          database: temporaryDatabase,
          upgrade,
        }),
      30_000,
    );

    it("backfills linked completion metadata and quarantines nonterminal legacy sessions", async () => {
      if (!upgrade) throw new Error("upgrade connection was not initialized");
      const organizationId = `legacy-upload-org-${newId()}`;
      const userId = `legacy-upload-user-${newId()}`;
      const memberId = `legacy-upload-member-${newId()}`;
      const workspaceId = newId();
      const fileId = newId();
      const invalidNameFileId = newId();
      const linkedCompletedId = newId();
      const invalidNameCompletedId = newId();
      const orphanCompletedId = newId();
      const pendingId = newId();
      const verifyingId = newId();
      const rejectedId = newId();
      const expiredId = newId();
      const cleanupPendingId = newId();

      await upgrade`
      INSERT INTO users (id, name, email, email_verified, created_at, updated_at)
      VALUES (${userId}, 'Legacy Upload User', ${`${newId()}@example.test`}, true, now(), now())
    `;
      await upgrade`
      INSERT INTO organizations (id, name, slug, created_at)
      VALUES (${organizationId}, 'Legacy Upload Organization', ${`legacy-upload-${newId()}`}, now())
    `;
      await upgrade`
      INSERT INTO workspaces (id, organization_id, name, created_by, updated_by)
      VALUES (${workspaceId}, ${organizationId}, 'Legacy Upload Workspace', ${userId}, ${userId})
    `;
      await upgrade`
      INSERT INTO members (
        id, organization_id, user_id, role, created_at, workspace_id
      ) VALUES (
        ${memberId}, ${organizationId}, ${userId}, 'owner', now(), ${workspaceId}
      )
    `;
      await upgrade`
      INSERT INTO workspace_principals (
        id, workspace_id, principal_type, user_id, member_id_snapshot
      ) VALUES (${newId()}, ${workspaceId}, 'user', ${userId}, ${memberId})
    `;
      await upgrade`
      INSERT INTO files (
        id, workspace_id, storage_provider, storage_bucket, storage_key,
        original_name, byte_size, checksum, sensitivity, uploaded_by,
        created_by, updated_by
      ) VALUES (
        ${fileId}, ${workspaceId}, 's3', 'private', ${`workspaces/${workspaceId}/uploads/${newId()}`},
        'linked-evidence.pdf', 42, 'sha256:legacy-linked', 'restricted',
        ${userId}, ${userId}, ${userId}
      )
    `;
      await upgrade`
      INSERT INTO files (
        id, workspace_id, storage_provider, storage_bucket, storage_key,
        original_name, byte_size, checksum, sensitivity, uploaded_by,
        created_by, updated_by
      ) VALUES (
        ${invalidNameFileId}, ${workspaceId}, 's3', 'private', ${`workspaces/${workspaceId}/uploads/${newId()}`},
        ${"x".repeat(256)}, 42, 'sha256:legacy-invalid-name', 'restricted',
        ${userId}, ${userId}, ${userId}
      )
    `;
      await upgrade`
      INSERT INTO upload_sessions (
        id, workspace_id, actor_id, intended_purpose, max_bytes, object_key,
        state, expires_at, completed_at, file_id, failure_code,
        created_by, updated_by
      ) VALUES
        (${linkedCompletedId}, ${workspaceId}, ${userId}, 'EVIDENCE', 42, ${`uploads/${linkedCompletedId}/${newId()}`}, 'completed', now() + interval '1 hour', now(), ${fileId}, NULL, ${userId}, ${userId}),
        (${invalidNameCompletedId}, ${workspaceId}, ${userId}, 'EVIDENCE', 42, ${`uploads/${invalidNameCompletedId}/${newId()}`}, 'completed', now() + interval '1 hour', now(), ${invalidNameFileId}, NULL, ${userId}, ${userId}),
        (${orphanCompletedId}, ${workspaceId}, ${userId}, 'EVIDENCE', 42, ${`uploads/${orphanCompletedId}/${newId()}`}, 'completed', now() + interval '1 hour', now(), NULL, NULL, ${userId}, ${userId}),
        (${pendingId}, ${workspaceId}, ${userId}, 'EVIDENCE', 42, ${`uploads/${pendingId}/${newId()}`}, 'pending', now() + interval '1 hour', NULL, NULL, NULL, ${userId}, ${userId}),
        (${verifyingId}, ${workspaceId}, ${userId}, 'EVIDENCE', 42, ${`uploads/${verifyingId}/${newId()}`}, 'verifying', now() + interval '1 hour', NULL, NULL, NULL, ${userId}, ${userId}),
        (${rejectedId}, ${workspaceId}, ${userId}, 'EVIDENCE', 42, ${`uploads/${rejectedId}/${newId()}`}, 'rejected', now() + interval '1 hour', NULL, NULL, 'checksum_mismatch', ${userId}, ${userId}),
        (${expiredId}, ${workspaceId}, ${userId}, 'EVIDENCE', 42, ${`uploads/${expiredId}/${newId()}`}, 'expired', now() - interval '1 hour', NULL, NULL, 'expired', ${userId}, ${userId}),
        (${cleanupPendingId}, ${workspaceId}, ${userId}, 'EVIDENCE', 42, ${`uploads/${cleanupPendingId}/${newId()}`}, 'cleanup_pending', now() - interval '1 hour', NULL, NULL, 'cleanup_retry', ${userId}, ${userId})
    `;

      await expect(
        applyMigrationFile(
          upgrade,
          "drizzle/0005_task11_upload_session_metadata.sql",
        ),
      ).resolves.toBeUndefined();

      const rows = await upgrade<
        {
          failure_code: string | null;
          id: string;
          original_name: string;
          sensitivity: string;
          state: string;
        }[]
      >`
      SELECT id, original_name, sensitivity, state, failure_code
      FROM upload_sessions
      WHERE workspace_id = ${workspaceId}
    `;
      const byId = Object.fromEntries(rows.map((row) => [row.id, row]));

      expect(byId[linkedCompletedId]).toMatchObject({
        failure_code: null,
        original_name: "linked-evidence.pdf",
        sensitivity: "restricted",
        state: "completed",
      });
      expect(byId[invalidNameCompletedId]).toMatchObject({
        failure_code: null,
        original_name: "metadata-unavailable",
        sensitivity: "restricted",
        state: "completed",
      });
      expect(byId[orphanCompletedId]).toMatchObject({
        failure_code: null,
        original_name: "metadata-unavailable",
        sensitivity: "internal",
        state: "completed",
      });
      for (const id of [pendingId, verifyingId]) {
        expect(byId[id]).toMatchObject({
          failure_code: "metadata_unavailable",
          original_name: "metadata-unavailable",
          sensitivity: "internal",
          state: "cleanup_pending",
        });
      }
      expect(byId[rejectedId]).toMatchObject({
        failure_code: "checksum_mismatch",
        state: "rejected",
      });
      expect(byId[expiredId]).toMatchObject({
        failure_code: "expired",
        state: "expired",
      });
      expect(byId[cleanupPendingId]).toMatchObject({
        failure_code: "cleanup_retry",
        state: "cleanup_pending",
      });
    }, 120_000);
  },
);

liveDescribe("0018 to 0019 to file ownership forward migration", () => {
  const temporaryDatabase = `humans_file_ownership_upgrade_${newId().replaceAll("-", "")}`;
  let admin: Sql | undefined;
  let upgrade: Sql | undefined;

  beforeAll(async () => {
    if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required");
    const parsed = new URL(databaseUrl);
    assertTestDatabaseResetAllowed({
      allowReset: resetAllowed,
      currentDatabase: parsed.pathname.slice(1),
      databaseUrl,
    });
    admin = postgres(withDatabase(databaseUrl, "postgres"), {
      max: 1,
      onnotice: () => undefined,
      prepare: false,
    });
    await admin.unsafe(`CREATE DATABASE "${temporaryDatabase}"`);
    upgrade = postgres(withDatabase(databaseUrl, temporaryDatabase), {
      max: 1,
      onnotice: () => undefined,
      prepare: false,
    });
    for (const path of throughTask13MigrationFiles) {
      await applyMigrationFile(upgrade, path);
    }
  }, 120_000);

  afterAll(
    () =>
      cleanupTemporaryDatabase({
        admin,
        database: temporaryDatabase,
        upgrade,
      }),
    30_000,
  );

  it("detects legacy cross-table collisions before installing serialized guards", async () => {
    if (!upgrade) throw new Error("upgrade connection was not initialized");
    await expect(
      applyMigrationFile(upgrade, "drizzle/0019_file_lifecycle.sql"),
    ).resolves.toBeUndefined();

    const userId = `ownership-user-${newId()}`;
    const organizationId = `ownership-org-${newId()}`;
    const memberId = `ownership-member-${newId()}`;
    const workspaceId = newId();
    const activeFileId = newId();
    const variantParentId = newId();
    const uploadSessionId = newId();
    const sharedKey = `uploads/${uploadSessionId}/${newId()}`;
    await upgrade`
      INSERT INTO users (id, name, email, email_verified, created_at, updated_at)
      VALUES (${userId}, 'Ownership User', ${`${newId()}@example.test`}, true, now(), now())
    `;
    await upgrade`
      INSERT INTO organizations (id, name, slug, created_at)
      VALUES (${organizationId}, 'Ownership Org', ${`ownership-${newId()}`}, now())
    `;
    await upgrade`
      INSERT INTO workspaces (id, organization_id, name, created_by, updated_by)
      VALUES (${workspaceId}, ${organizationId}, 'Ownership', ${userId}, ${userId})
    `;
    await upgrade`
      INSERT INTO members (id, organization_id, user_id, role, created_at, workspace_id)
      VALUES (${memberId}, ${organizationId}, ${userId}, 'owner', now(), ${workspaceId})
    `;
    await upgrade`
      INSERT INTO workspace_principals (
        id, workspace_id, principal_type, user_id, member_id_snapshot
      ) VALUES (${newId()}, ${workspaceId}, 'user', ${userId}, ${memberId})
    `;
    await upgrade`
      INSERT INTO files (
        id, workspace_id, storage_provider, storage_bucket, storage_key,
        original_name, byte_size, checksum, uploaded_by, created_by, updated_by
      ) VALUES
        (${activeFileId}, ${workspaceId}, 'minio', 'private', ${sharedKey},
         'active.txt', 1, 'sha256:active', ${userId}, ${userId}, ${userId}),
        (${variantParentId}, ${workspaceId}, 'minio', 'private', ${`uploads/${variantParentId}/${newId()}`},
         'parent.txt', 1, 'sha256:parent', ${userId}, ${userId}, ${userId})
    `;
    await upgrade`
      INSERT INTO upload_sessions (
        id, workspace_id, actor_id, intended_purpose, original_name, max_bytes,
        expected_checksum, expected_media_type, object_key, state, expires_at,
        completed_at, file_id, created_by, updated_by
      ) VALUES (
        ${uploadSessionId}, ${workspaceId}, ${userId}, 'EVIDENCE', 'active.txt', 1,
        ${"aa".repeat(32)}, 'text/plain', ${sharedKey}, 'completed',
        now() + interval '1 hour', now(), ${activeFileId}, ${userId}, ${userId}
      )
    `;
    const corruptVariantId = newId();
    await upgrade`
      INSERT INTO file_variants (
        id, workspace_id, parent_file_id, kind, storage_provider,
        storage_bucket, storage_key, checksum, created_by
      ) VALUES (
        ${corruptVariantId}, ${workspaceId}, ${variantParentId}, 'legacy',
        'minio', 'private', ${sharedKey}, 'sha256:legacy', ${userId}
      )
    `;

    await expect(
      applyMigrationFile(upgrade, "drizzle/0020_file_coordinate_ownership.sql"),
    ).rejects.toMatchObject({ code: "23505" });

    await upgrade`DELETE FROM file_variants WHERE id = ${corruptVariantId}`;
    await expect(
      applyMigrationFile(upgrade, "drizzle/0020_file_coordinate_ownership.sql"),
    ).resolves.toBeUndefined();

    const [column] = await upgrade<[{ is_nullable: string }]>`
      SELECT is_nullable
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'files'
        AND column_name = 'cleanup_completed_at'
    `;
    expect(column).toEqual({ is_nullable: "YES" });
    const triggers = await upgrade<{ tgname: string }[]>`
      SELECT tgname
      FROM pg_trigger
      WHERE NOT tgisinternal
        AND tgrelid IN ('files'::regclass, 'file_variants'::regclass)
        AND tgname LIKE '%object_coordinate_guard%'
      ORDER BY tgname
    `;
    expect(triggers.map(({ tgname }) => tgname)).toEqual([
      "file_variants_object_coordinate_guard_trigger",
      "files_object_coordinate_guard_trigger",
    ]);
  }, 120_000);
});

liveDescribe(
  "Task 12 protected-value forward migration on PostgreSQL 18",
  () => {
    const temporaryDatabase = `humans_task12_upgrade_${newId().replaceAll("-", "")}`;
    let admin: Sql | undefined;
    let upgrade: Sql | undefined;

    beforeAll(async () => {
      if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required");
      const parsed = new URL(databaseUrl);
      assertTestDatabaseResetAllowed({
        allowReset: resetAllowed,
        currentDatabase: parsed.pathname.slice(1),
        databaseUrl,
      });
      admin = postgres(withDatabase(databaseUrl, "postgres"), {
        max: 1,
        onnotice: () => undefined,
        prepare: false,
      });
      await admin.unsafe(`CREATE DATABASE "${temporaryDatabase}"`);
      upgrade = postgres(withDatabase(databaseUrl, temporaryDatabase), {
        max: 1,
        onnotice: () => undefined,
        prepare: false,
      });
      for (const path of task12PrerequisiteMigrationFiles) {
        await applyMigrationFile(upgrade, path);
      }
    }, 120_000);

    afterAll(
      () =>
        cleanupTemporaryDatabase({
          admin,
          database: temporaryDatabase,
          upgrade,
        }),
      30_000,
    );

    it("preserves legacy bytes as unversioned and constrains only canonical v1 rows", async () => {
      if (!upgrade) throw new Error("upgrade connection was not initialized");
      const userId = `task12-user-${newId()}`;
      const organizationId = `task12-org-${newId()}`;
      const memberId = `task12-member-${newId()}`;
      const workspaceId = newId();
      const personId = newId();
      const contactId = newId();
      const identifierId = newId();
      const legacyContactEnvelope = "legacy-contact-envelope";
      const legacyContactBlind = "Legacy Contact Blind Bytes";
      const legacyIdentifierEnvelope = "legacy-identifier-envelope";
      const legacyIdentifierBlind = "Legacy Identifier Blind Bytes";

      await upgrade`
      INSERT INTO users (id, name, email, email_verified, created_at, updated_at)
      VALUES (${userId}, 'Task 12 User', ${`${newId()}@example.test`}, true, now(), now())
    `;
      await upgrade`
      INSERT INTO organizations (id, name, slug, created_at)
      VALUES (${organizationId}, 'Task 12 Organization', ${`task12-${newId()}`}, now())
    `;
      await upgrade`
      INSERT INTO workspaces (id, organization_id, name, created_by, updated_by)
      VALUES (${workspaceId}, ${organizationId}, 'Task 12 Workspace', ${userId}, ${userId})
    `;
      await upgrade`
      INSERT INTO members (id, organization_id, user_id, role, created_at, workspace_id)
      VALUES (${memberId}, ${organizationId}, ${userId}, 'owner', now(), ${workspaceId})
    `;
      await upgrade`
      INSERT INTO workspace_principals (
        id, workspace_id, principal_type, user_id, member_id_snapshot
      ) VALUES (${newId()}, ${workspaceId}, 'user', ${userId}, ${memberId})
    `;
      await upgrade`
      INSERT INTO people (id, workspace_id, display_name, created_by, updated_by)
      VALUES (${personId}, ${workspaceId}, 'Task 12 Person', ${userId}, ${userId})
    `;
      await upgrade`
      INSERT INTO contact_points (
        id, workspace_id, kind, encrypted_display_value, blind_index,
        created_by, updated_by
      ) VALUES (
        ${contactId}, ${workspaceId}, 'phone', ${legacyContactEnvelope},
        ${legacyContactBlind}, ${userId}, ${userId}
      )
    `;
      await upgrade`
      INSERT INTO person_identifiers (
        id, workspace_id, person_id, namespace, identifier_type,
        encrypted_raw_value, blind_index, created_by, updated_by
      ) VALUES (
        ${identifierId}, ${workspaceId}, ${personId}, 'legacy', 'custom',
        ${legacyIdentifierEnvelope}, ${legacyIdentifierBlind}, ${userId}, ${userId}
      )
    `;

      await expect(
        applyMigrationFile(upgrade, "drizzle/0008_task12_foundations.sql"),
      ).resolves.toBeUndefined();

      const [legacyContact] = await upgrade<
        [
          {
            blind_index: string;
            blind_index_version: number | null;
            encrypted_display_value: string;
          },
        ]
      >`
      SELECT blind_index, blind_index_version, encrypted_display_value
      FROM contact_points
      WHERE id = ${contactId}
    `;
      const [legacyIdentifier] = await upgrade<
        [
          {
            blind_index: string;
            blind_index_version: number | null;
            encrypted_raw_value: string;
          },
        ]
      >`
      SELECT blind_index, blind_index_version, encrypted_raw_value
      FROM person_identifiers
      WHERE id = ${identifierId}
    `;
      expect(legacyContact).toEqual({
        blind_index: legacyContactBlind,
        blind_index_version: null,
        encrypted_display_value: legacyContactEnvelope,
      });
      expect(legacyIdentifier).toEqual({
        blind_index: legacyIdentifierBlind,
        blind_index_version: null,
        encrypted_raw_value: legacyIdentifierEnvelope,
      });

      const v1ContactId = newId();
      const v1IdentifierId = newId();
      await upgrade`
      INSERT INTO contact_points (
        id, workspace_id, kind, encrypted_display_value, blind_index,
        created_by, updated_by
      ) VALUES (
        ${v1ContactId}, ${workspaceId}, 'phone', 'v1-contact-envelope',
        ${"a".repeat(64)}, ${userId}, ${userId}
      )
    `;
      await upgrade`
      INSERT INTO person_identifiers (
        id, workspace_id, person_id, namespace, identifier_type,
        encrypted_raw_value, blind_index, created_by, updated_by
      ) VALUES (
        ${v1IdentifierId}, ${workspaceId}, ${personId}, 'task12', 'custom',
        'v1-identifier-envelope', ${"b".repeat(64)}, ${userId}, ${userId}
      )
    `;
      const [versions] = await upgrade<
        [{ contact_version: number; identifier_version: number }]
      >`
      SELECT
        (SELECT blind_index_version FROM contact_points WHERE id = ${v1ContactId}) AS contact_version,
        (SELECT blind_index_version FROM person_identifiers WHERE id = ${v1IdentifierId}) AS identifier_version
    `;
      expect(versions).toEqual({ contact_version: 1, identifier_version: 1 });

      await expect(
        upgrade`
        UPDATE contact_points
        SET blind_index_version = 2
        WHERE id = ${v1ContactId}
      `,
      ).rejects.toMatchObject({ code: "23514" });
      await expect(
        upgrade`
        UPDATE contact_points
        SET blind_index = ${"A".repeat(64)}
        WHERE id = ${v1ContactId}
      `,
      ).rejects.toMatchObject({ code: "23514" });
      await expect(
        upgrade`
        UPDATE person_identifiers
        SET normalized_value = 'must-not-persist'
        WHERE id = ${v1IdentifierId}
      `,
      ).rejects.toMatchObject({ code: "23514" });

      const indexes = await upgrade<{ indexdef: string; indexname: string }[]>`
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
    }, 120_000);
  },
);

liveDescribe(
  "Task 12 search/analysis forward migration on PostgreSQL 18",
  () => {
    const temporaryDatabase = `humans_task12_search_${newId().replaceAll("-", "")}`;
    let admin: Sql | undefined;
    let upgrade: Sql | undefined;

    beforeAll(async () => {
      if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required");
      const parsed = new URL(databaseUrl);
      assertTestDatabaseResetAllowed({
        allowReset: resetAllowed,
        currentDatabase: parsed.pathname.slice(1),
        databaseUrl,
      });
      admin = postgres(withDatabase(databaseUrl, "postgres"), {
        max: 1,
        onnotice: () => undefined,
        prepare: false,
      });
      await admin.unsafe(`CREATE DATABASE "${temporaryDatabase}"`);
      upgrade = postgres(withDatabase(databaseUrl, temporaryDatabase), {
        max: 1,
        onnotice: () => undefined,
        prepare: false,
      });
      for (const path of task12PrerequisiteMigrationFiles)
        await applyMigrationFile(upgrade, path);
      await applyMigrationFile(upgrade, "drizzle/0008_task12_foundations.sql");
    }, 120_000);

    afterAll(
      () =>
        cleanupTemporaryDatabase({
          admin,
          database: temporaryDatabase,
          upgrade,
        }),
      30_000,
    );

    it("rejects populated provisional rows, then establishes strict generated contracts", async () => {
      if (!upgrade) throw new Error("upgrade connection was not initialized");
      const organizationId = `task12-search-org-${newId()}`;
      const userId = `task12-search-user-${newId()}`;
      const memberId = `task12-search-member-${newId()}`;
      const principalId = newId();
      const workspaceId = newId();
      const personId = newId();
      await upgrade`
      INSERT INTO users (id, name, email, email_verified, created_at, updated_at)
      VALUES (${userId}, 'Task 12 Search User', ${`${newId()}@example.test`}, true, now(), now())
    `;
      await upgrade`
      INSERT INTO organizations (id, name, slug, created_at)
      VALUES (${organizationId}, 'Task 12 Search', ${`task12-search-${newId()}`}, now())
    `;
      await upgrade`
      INSERT INTO workspaces (id, organization_id, name, created_by, updated_by)
      VALUES (${workspaceId}, ${organizationId}, 'Task 12 Search', ${userId}, ${userId})
    `;
      await upgrade`
      INSERT INTO members (id, organization_id, user_id, role, created_at, workspace_id)
      VALUES (${memberId}, ${organizationId}, ${userId}, 'owner', now(), ${workspaceId})
    `;
      await upgrade`
      INSERT INTO workspace_principals (
        id, workspace_id, principal_type, user_id, member_id_snapshot
      ) VALUES (${principalId}, ${workspaceId}, 'user', ${userId}, ${memberId})
    `;
      await upgrade`
      INSERT INTO people (id, workspace_id, display_name, created_by, updated_by)
      VALUES (${personId}, ${workspaceId}, 'Task 12 Analysis Owner', ${userId}, ${userId})
    `;
      await upgrade`
      INSERT INTO search_documents (
        id, workspace_id, resource_kind, resource_id, redacted_text,
        source_version
      ) VALUES (${newId()}, ${workspaceId}, 'person', ${newId()}, 'legacy', 1)
    `;

      await expect(
        applyMigrationFile(upgrade, "drizzle/0009_task12_search_analysis.sql"),
      ).rejects.toThrow(
        /requires empty provisional search and analysis tables/u,
      );

      await upgrade`DELETE FROM search_documents`;
      await expect(
        applyMigrationFile(upgrade, "drizzle/0009_task12_search_analysis.sql"),
      ).resolves.toBeUndefined();

      const columns = await upgrade<
        {
          column_default: string | null;
          column_name: string;
          is_generated: string;
          is_nullable: string;
        }[]
      >`
      SELECT column_name, is_nullable, column_default, is_generated
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND (
          (table_name = 'search_documents' AND column_name IN ('result_id', 'search_vector'))
          OR (table_name = 'graph_snapshots' AND column_name IN ('manifest_hash', 'manifest_material', 'actor_principal_id'))
          OR (table_name = 'analysis_results' AND column_name = 'payload_hash')
        )
      ORDER BY column_name
    `;
      expect(columns).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            column_name: "actor_principal_id",
            column_default: null,
            is_nullable: "NO",
          }),
          expect.objectContaining({
            column_name: "manifest_hash",
            column_default: null,
            is_nullable: "NO",
          }),
          expect.objectContaining({
            column_name: "manifest_material",
            column_default: null,
            is_nullable: "NO",
          }),
          expect.objectContaining({
            column_name: "payload_hash",
            column_default: null,
            is_nullable: "NO",
          }),
          expect.objectContaining({
            column_name: "result_id",
            column_default: null,
            is_nullable: "NO",
          }),
          expect.objectContaining({
            column_name: "search_vector",
            is_generated: "ALWAYS",
            is_nullable: "NO",
          }),
        ]),
      );

      const ginIndexes = await upgrade<
        { indexdef: string; indisvalid: boolean }[]
      >`
      SELECT pg_get_indexdef(i.indexrelid) AS indexdef, i.indisvalid
      FROM pg_index i
      INNER JOIN pg_class c ON c.oid = i.indexrelid
      WHERE c.relname = 'search_documents_search_vector_gin'
    `;
      expect(ginIndexes).toEqual([
        expect.objectContaining({
          indisvalid: true,
          indexdef: expect.stringMatching(/USING gin \(search_vector\)/u),
        }),
      ]);

      await expect(
        upgrade`
        INSERT INTO search_documents (
          id, workspace_id, source_kind, source_id, source_version,
          result_kind, result_id, sensitivity, title_text, display_text
        ) VALUES (
          ${newId()}, ${workspaceId}, 'file_bytes', ${newId()}, 1,
          'PERSON', ${newId()}, 'public', 'safe', 'safe'
        )
      `,
      ).rejects.toMatchObject({ code: "23514" });

      const triggers = await upgrade<{ tgname: string }[]>`
      SELECT tgname
      FROM pg_trigger
      WHERE NOT tgisinternal
        AND tgname IN (
          'query_runs_validate_actor_kind_trigger',
          'graph_snapshots_validate_actor_kind_trigger',
          'analysis_runs_validate_actor_kind_trigger',
          'graph_snapshots_immutable_trigger',
          'analysis_results_immutable_trigger',
          'saved_queries_validate_owner_trigger'
        )
      ORDER BY tgname
    `;
      expect(triggers.map(({ tgname }) => tgname)).toEqual([
        "analysis_results_immutable_trigger",
        "analysis_runs_validate_actor_kind_trigger",
        "graph_snapshots_immutable_trigger",
        "graph_snapshots_validate_actor_kind_trigger",
        "query_runs_validate_actor_kind_trigger",
        "saved_queries_validate_owner_trigger",
      ]);

      const checks = await upgrade<{ conname: string; definition: string }[]>`
      SELECT conname, pg_get_constraintdef(oid) AS definition
      FROM pg_constraint
      WHERE conname IN (
        'graph_snapshots_manifest_check',
        'graph_snapshots_manifest_material_check',
        'analysis_runs_contract_check',
        'analysis_runs_timing_check',
        'analysis_results_payload_check',
        'search_documents_source_kind_check'
      )
      ORDER BY conname
    `;
      expect(checks).toHaveLength(6);
      const checkText = JSON.stringify(checks);
      for (const contractTerm of [
        "jsonb_typeof",
        "manifest_material",
        "33554432",
        "LOUVAIN_COMMUNITY",
        "completed",
        "community",
        "source_kind",
      ])
        expect(checkText).toContain(contractTerm);

      await expect(
        applyMigrationFile(upgrade, "drizzle/0010_task12_corrections.sql"),
      ).resolves.toBeUndefined();
      const correctionTriggers = await upgrade<{ tgname: string }[]>`
        SELECT tgname
        FROM pg_trigger
        WHERE NOT tgisinternal
          AND tgrelid IN ('analysis_results'::regclass, 'analysis_runs'::regclass)
          AND tgname IN (
            'analysis_results_immutable_trigger',
            'analysis_results_lifecycle_trigger',
            'analysis_runs_finalize_only_trigger'
          )
        ORDER BY tgname
      `;
      expect(correctionTriggers.map(({ tgname }) => tgname)).toEqual([
        "analysis_results_lifecycle_trigger",
        "analysis_runs_finalize_only_trigger",
      ]);
      const correctionForeignKeys = await upgrade<
        { conname: string; definition: string }[]
      >`
        SELECT conname, pg_get_constraintdef(oid) AS definition
        FROM pg_constraint
        WHERE conname IN (
          'analysis_results_workspace_run_fk',
          'analysis_results_workspace_person_fk',
          'analysis_results_workspace_relationship_fk'
        )
        ORDER BY conname
      `;
      expect(correctionForeignKeys).toHaveLength(3);
      expect(
        correctionForeignKeys.every(({ definition }) =>
          definition.includes("ON DELETE RESTRICT"),
        ),
      ).toBe(true);

      const snapshotId = newId();
      const runId = newId();
      const resultId = newId();
      await upgrade`
        INSERT INTO graph_snapshots (
          id, workspace_id, manifest_schema, manifest_hash, manifest_material,
          query_input, query_hash, authorization_hash, actor_principal_id,
          actor_kind, included_person_versions, included_relationship_versions,
          included_relationship_type_versions, algorithm, algorithm_version,
          algorithm_config_hash, algorithm_configuration, runtime_contract,
          created_by
        ) VALUES (
          ${snapshotId}, ${workspaceId}, 'humans.graph-snapshot-manifest.v1',
          ${"11".repeat(32)}, '{"fixture":"upgrade-0010"}'::jsonb,
          '{}'::jsonb, ${"22".repeat(32)}, ${"33".repeat(32)}, ${principalId},
          'USER', '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, 'DEGREE',
          'upgrade-v1', ${"44".repeat(32)}, '{"projection":"upgrade-v1"}'::jsonb,
          '{"serviceVersion":"upgrade-test"}'::jsonb, ${userId}
        )
      `;
      await upgrade`
        INSERT INTO analysis_runs (
          id, workspace_id, algorithm, algorithm_version, configuration_hash,
          graph_snapshot_id, actor_principal_id, actor_kind, configuration,
          state, started_at, created_by
        ) VALUES (
          ${runId}, ${workspaceId}, 'DEGREE', 'upgrade-v1', ${"44".repeat(32)},
          ${snapshotId}, ${principalId}, 'USER', '{"projection":"upgrade-v1"}'::jsonb,
          'running', now(), ${userId}
        )
      `;
      await upgrade`
        INSERT INTO analysis_results (
          id, workspace_id, analysis_run_id, result_kind, payload_schema,
          payload_hash, export_label, subject_person_id, numeric_value, rank
        ) VALUES (
          ${resultId}, ${workspaceId}, ${runId}, 'degree',
          'humans.graph-analysis-result.v1', ${"55".repeat(32)}, 'degree',
          ${personId}, 1, 1
        )
      `;
      await expect(
        upgrade`
          UPDATE analysis_runs
          SET state = 'completed', completed_at = now()
          WHERE workspace_id = ${workspaceId} AND id = ${runId}
        `,
      ).resolves.toBeDefined();
      await expect(
        upgrade`
          INSERT INTO analysis_results (
            id, workspace_id, analysis_run_id, result_kind, payload_schema,
            payload_hash, export_label, subject_person_id, numeric_value, rank
          ) VALUES (
            ${newId()}, ${workspaceId}, ${runId}, 'degree',
            'humans.graph-analysis-result.v1', ${"66".repeat(32)}, 'degree',
            ${personId}, 2, 2
          )
        `,
      ).rejects.toMatchObject({ code: "23514" });
      await expect(
        upgrade`UPDATE analysis_results SET numeric_value = 2 WHERE id = ${resultId}`,
      ).rejects.toMatchObject({ code: "23514" });
      await expect(
        upgrade`DELETE FROM analysis_results WHERE id = ${resultId}`,
      ).rejects.toMatchObject({ code: "23514" });
      await expect(
        upgrade`DELETE FROM analysis_runs WHERE id = ${runId}`,
      ).rejects.toMatchObject({ code: "23001" });
      await expect(
        upgrade`DELETE FROM graph_snapshots WHERE id = ${snapshotId}`,
      ).rejects.toMatchObject({ code: "23001" });
    }, 120_000);
  },
);
