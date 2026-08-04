// @vitest-environment node

import { readdirSync, readFileSync } from "node:fs";
import postgres, { type Sql } from "postgres";
import { describe, expect, it } from "vitest";

import { newId } from "@/db/id";
import { assertTestDatabaseResetAllowed } from "../support/database-reset-guard";

const databaseUrl = process.env.TEST_DATABASE_URL;
const resetAllowed = process.env.ALLOW_TEST_DATABASE_RESET;
const liveDescribe = databaseUrl || resetAllowed ? describe : describe.skip;
const task2Migration = "drizzle/0018_task13_ai_analyst.sql";
const prerequisiteMigrations = readdirSync("drizzle")
  .filter((path) => /^00(?:0[0-9]|1[0-7])_.*\.sql$/u.test(path))
  .sort()
  .map((path) => `drizzle/${path}`);

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

async function withUpgradeDatabase(
  run: (sql: Sql) => Promise<void>,
): Promise<void> {
  if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required");
  const parsed = new URL(databaseUrl);
  assertTestDatabaseResetAllowed({
    allowReset: resetAllowed,
    currentDatabase: parsed.pathname.slice(1),
    databaseUrl,
  });
  const database = `humans_ai_principal_${newId().replaceAll("-", "")}`;
  const admin = postgres(withDatabase(databaseUrl, "postgres"), {
    max: 1,
    onnotice: () => undefined,
    prepare: false,
  });
  let upgrade: Sql | undefined;
  try {
    await admin.unsafe(`CREATE DATABASE "${database}"`);
    upgrade = postgres(withDatabase(databaseUrl, database), {
      max: 1,
      onnotice: () => undefined,
      prepare: false,
    });
    for (const migration of prerequisiteMigrations) {
      await applyMigrationFile(upgrade, migration);
    }
    await run(upgrade);
  } finally {
    await upgrade?.end({ timeout: 5 });
    await admin.unsafe("SET statement_timeout = '20s'");
    await admin.unsafe(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
    await admin.end({ timeout: 5 });
  }
}

type PrincipalFixture = {
  apiKeyPrincipalId: string;
  foreignPrincipalId: string;
  foreignWorkspaceId: string;
  legacyJobs: readonly string[];
  messageId: string;
  runId: string;
  threadId: string;
  userId: string;
  userPrincipalId: string;
  workspaceId: string;
};

async function seedLegacyRows(sql: Sql): Promise<PrincipalFixture> {
  const organizationId = `org-${newId()}`;
  const foreignOrganizationId = `org-${newId()}`;
  const workspaceId = newId();
  const foreignWorkspaceId = newId();
  const userId = `user-${newId()}`;
  const memberId = `member-${newId()}`;
  const userPrincipalId = newId();
  const apiKeyId = `key-${newId()}`;
  const apiKeyPrincipalId = newId();
  const foreignPrincipalId = newId();
  const threadId = newId();
  const messageId = newId();
  const runId = newId();
  const legacyJobs = [newId(), newId()] as const;

  await sql`
    INSERT INTO organizations (id, name, slug, created_at)
    VALUES
      (${organizationId}, 'AI migration', ${`ai-migration-${newId()}`}, now()),
      (${foreignOrganizationId}, 'AI migration foreign', ${`ai-migration-${newId()}`}, now())
  `;
  await sql`
    INSERT INTO workspaces (id, organization_id, name, created_by, updated_by)
    VALUES
      (${workspaceId}, ${organizationId}, 'AI migration', 'system', 'system'),
      (${foreignWorkspaceId}, ${foreignOrganizationId}, 'AI migration foreign', 'system', 'system')
  `;
  await sql`
    INSERT INTO users (id, name, email, email_verified, created_at, updated_at)
    VALUES (${userId}, 'Migration User', ${`${newId()}@example.test`}, true, now(), now())
  `;
  await sql`
    INSERT INTO members (id, organization_id, user_id, role, created_at, workspace_id)
    VALUES (${memberId}, ${organizationId}, ${userId}, 'analyst', now(), ${workspaceId})
  `;
  await sql`
    INSERT INTO api_keys (
      id, config_id, reference_id, key, enabled, created_at, updated_at, workspace_id
    ) VALUES (
      ${apiKeyId}, 'organization', ${organizationId}, ${`hashed-${newId()}`}, true,
      now(), now(), ${workspaceId}
    )
  `;
  await sql`
    INSERT INTO workspace_principals (
      id, workspace_id, principal_type, user_id, member_id_snapshot
    ) VALUES (${userPrincipalId}, ${workspaceId}, 'user', ${userId}, ${memberId})
  `;
  await sql`
    INSERT INTO workspace_principals (
      id, workspace_id, principal_type, api_key_id
    ) VALUES (${apiKeyPrincipalId}, ${workspaceId}, 'api_key', ${apiKeyId})
  `;
  await sql`
    INSERT INTO workspace_principals (
      id, workspace_id, principal_type, system_key
    ) VALUES (${foreignPrincipalId}, ${foreignWorkspaceId}, 'system', 'migration-test')
  `;
  await sql`
    INSERT INTO ai_threads (
      id, workspace_id, owner_id, title, created_by, updated_by
    ) VALUES (
      ${threadId}, ${workspaceId}, ${userId}, 'Legacy AI thread', ${userId}, ${userId}
    )
  `;
  await sql`
    INSERT INTO ai_messages (
      id, workspace_id, thread_id, role, encrypted_content, content_hash,
      created_by, updated_by
    ) VALUES (
      ${messageId}, ${workspaceId}, ${threadId}, 'user', 'sealed:legacy',
      'sha256:legacy', ${userId}, ${userId}
    )
  `;
  await sql`
    INSERT INTO ai_runs (
      id, workspace_id, thread_id, message_id, provider, base_url_fingerprint,
      model, prompt_hash, configuration_hash, created_by
    ) VALUES (
      ${runId}, ${workspaceId}, ${threadId}, ${messageId}, 'ollama',
      'sha256:provider', 'legacy-model', 'sha256:prompt', 'sha256:config', ${userId}
    )
  `;
  await sql`
    INSERT INTO jobs (
      id, workspace_id, kind, encrypted_payload, payload_hash, request_hash,
      idempotency_key, created_by
    ) VALUES
      (${legacyJobs[0]}, ${workspaceId}, 'import_execute', 'sealed:import', ${`sha256:${"1".repeat(64)}`}, ${`sha256:${"2".repeat(64)}`}, ${`legacy-import-${newId()}`}, ${userId}),
      (${legacyJobs[1]}, ${workspaceId}, 'file_cleanup', 'sealed:cleanup', ${`sha256:${"3".repeat(64)}`}, ${`sha256:${"4".repeat(64)}`}, ${`legacy-cleanup-${newId()}`}, ${userId})
  `;

  return {
    apiKeyPrincipalId,
    foreignPrincipalId,
    foreignWorkspaceId,
    legacyJobs,
    messageId,
    runId,
    threadId,
    userId,
    userPrincipalId,
    workspaceId,
  };
}

liveDescribe("Task 13 AI principal attribution migration", () => {
  it("backfills user actors, accepts API-key actors, and preserves legacy jobs", async () => {
    await withUpgradeDatabase(async (sql) => {
      const fixture = await seedLegacyRows(sql);
      await sql.begin(async (transaction) => {
        await applyMigrationFile(transaction as unknown as Sql, task2Migration);
      });

      const [thread] = await sql<
        [{ owner_id: string; created_by: string; updated_by: string }]
      >`SELECT owner_id, created_by, updated_by FROM ai_threads WHERE id = ${fixture.threadId}`;
      expect(thread).toEqual({
        owner_id: fixture.userPrincipalId,
        created_by: fixture.userPrincipalId,
        updated_by: fixture.userPrincipalId,
      });
      const [message] = await sql<
        [{ created_by: string; updated_by: string }]
      >`SELECT created_by, updated_by FROM ai_messages WHERE id = ${fixture.messageId}`;
      expect(message).toEqual({
        created_by: fixture.userPrincipalId,
        updated_by: fixture.userPrincipalId,
      });
      const [run] = await sql<
        [{ created_by: string }]
      >`SELECT created_by FROM ai_runs WHERE id = ${fixture.runId}`;
      expect(run.created_by).toBe(fixture.userPrincipalId);

      const legacyJobs = await sql<
        { created_by: string; id: string; principal_id: string | null }[]
      >`
        SELECT id, created_by, principal_id FROM jobs
        WHERE id IN (${fixture.legacyJobs[0]}, ${fixture.legacyJobs[1]})
        ORDER BY id
      `;
      expect(legacyJobs).toHaveLength(2);
      expect(legacyJobs.every((job) => job.created_by === fixture.userId)).toBe(
        true,
      );
      expect(legacyJobs.every((job) => job.principal_id === null)).toBe(true);

      const apiThreadId = newId();
      const apiMessageId = newId();
      const apiRunId = newId();
      await expect(
        sql`
          INSERT INTO ai_threads (
            id, workspace_id, owner_id, title, created_by, updated_by
          ) VALUES (
            ${apiThreadId}, ${fixture.workspaceId}, ${fixture.apiKeyPrincipalId},
            'API-key AI thread', ${fixture.apiKeyPrincipalId}, ${fixture.apiKeyPrincipalId}
          )
        `,
      ).resolves.toBeDefined();
      await expect(
        sql`
          INSERT INTO ai_messages (
            id, workspace_id, thread_id, role, encrypted_content, content_hash,
            created_by, updated_by
          ) VALUES (
            ${apiMessageId}, ${fixture.workspaceId}, ${apiThreadId}, 'user',
            'sealed:api', 'sha256:api', ${fixture.apiKeyPrincipalId},
            ${fixture.apiKeyPrincipalId}
          )
        `,
      ).resolves.toBeDefined();
      await expect(
        sql`
          INSERT INTO ai_runs (
            id, workspace_id, thread_id, message_id, provider,
            base_url_fingerprint, model, prompt_hash, configuration_hash, created_by
          ) VALUES (
            ${apiRunId}, ${fixture.workspaceId}, ${apiThreadId}, ${apiMessageId},
            'ollama', 'sha256:api-provider', 'api-model', 'sha256:api-prompt',
            'sha256:api-config', ${fixture.apiKeyPrincipalId}
          )
        `,
      ).resolves.toBeDefined();

      await expect(
        sql`
          INSERT INTO ai_threads (
            id, workspace_id, owner_id, title, created_by, updated_by
          ) VALUES (
            ${newId()}, ${fixture.workspaceId}, ${fixture.foreignPrincipalId},
            'Foreign principal', ${fixture.apiKeyPrincipalId}, ${fixture.apiKeyPrincipalId}
          )
        `,
      ).rejects.toMatchObject({ code: "23503" });

      await expect(
        sql`
          INSERT INTO jobs (
            id, workspace_id, kind, encrypted_payload, payload_hash, request_hash,
            idempotency_key, principal_id
          ) VALUES (
            ${newId()}, ${fixture.workspaceId}, 'ai_execute', 'sealed:ai',
            ${`sha256:${"5".repeat(64)}`}, ${`sha256:${"6".repeat(64)}`},
            ${`ai-${newId()}`}, ${fixture.apiKeyPrincipalId}
          )
        `,
      ).resolves.toBeDefined();
      await expect(
        sql`
          INSERT INTO jobs (
            id, workspace_id, kind, encrypted_payload, payload_hash, request_hash,
            idempotency_key, principal_id
          ) VALUES (
            ${newId()}, ${fixture.workspaceId}, 'ai_execute', 'sealed:foreign',
            ${`sha256:${"b".repeat(64)}`}, ${`sha256:${"c".repeat(64)}`},
            ${`foreign-${newId()}`}, ${fixture.foreignPrincipalId}
          )
        `,
      ).rejects.toMatchObject({ code: "23503" });
      await expect(
        sql`
          INSERT INTO jobs (
            id, workspace_id, kind, encrypted_payload, payload_hash, request_hash,
            idempotency_key, created_by, principal_id
          ) VALUES (
            ${newId()}, ${fixture.workspaceId}, 'ai_execute', 'sealed:conflict',
            ${`sha256:${"7".repeat(64)}`}, ${`sha256:${"8".repeat(64)}`},
            ${`conflict-${newId()}`}, ${fixture.userId}, ${fixture.userPrincipalId}
          )
        `,
      ).rejects.toMatchObject({ code: "23514" });
      await expect(
        sql`
          INSERT INTO jobs (
            id, workspace_id, kind, encrypted_payload, payload_hash, request_hash,
            idempotency_key
          ) VALUES (
            ${newId()}, ${fixture.workspaceId}, 'ai_execute', 'sealed:missing',
            ${`sha256:${"9".repeat(64)}`}, ${`sha256:${"a".repeat(64)}`},
            ${`missing-${newId()}`}
          )
        `,
      ).rejects.toMatchObject({ code: "23514" });
    });
  }, 180_000);

  it.each(["missing", "ambiguous"] as const)(
    "fails closed and rolls back an %s legacy principal backfill",
    async (failure) => {
      await withUpgradeDatabase(async (sql) => {
        const fixture = await seedLegacyRows(sql);
        if (failure === "missing") {
          await sql`SET session_replication_role = replica`;
          await sql`DELETE FROM workspace_principals WHERE id = ${fixture.userPrincipalId}`;
          await sql`SET session_replication_role = origin`;
        } else {
          await sql.unsafe(
            "ALTER TABLE workspace_principals DROP CONSTRAINT workspace_principals_workspace_user_unique CASCADE",
          );
          await sql`
            INSERT INTO workspace_principals (
              id, workspace_id, principal_type, user_id, member_id_snapshot
            )
            SELECT ${newId()}, workspace_id, principal_type, user_id, member_id_snapshot
            FROM workspace_principals
            WHERE id = ${fixture.userPrincipalId}
          `;
        }

        await expect(
          sql.begin(async (transaction) => {
            await applyMigrationFile(
              transaction as unknown as Sql,
              task2Migration,
            );
          }),
        ).rejects.toThrow(/exactly one workspace principal/i);

        const [column] = await sql<
          [{ data_type: string }]
        >`SELECT data_type FROM information_schema.columns WHERE table_name = 'ai_threads' AND column_name = 'owner_id'`;
        expect(column.data_type).toBe("text");
        const [thread] = await sql<
          [{ owner_id: string }]
        >`SELECT owner_id FROM ai_threads WHERE id = ${fixture.threadId}`;
        expect(thread.owner_id).toBe(fixture.userId);
      });
    },
    180_000,
  );
});
