// @vitest-environment node

import { readFileSync } from "node:fs";

import postgres, { type Sql } from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { newId } from "@/db/id";

import { assertTestDatabaseResetAllowed } from "../support/database-reset-guard";

const databaseUrl = process.env.TEST_DATABASE_URL;
const resetAllowed = process.env.ALLOW_TEST_DATABASE_RESET;
const liveDescribe = databaseUrl ? describe : describe.skip;

const prerequisiteMigrations = [
  "drizzle/0000_core.sql",
  "drizzle/0001_task4_invariants.sql",
  "drizzle/0002_core.sql",
  "drizzle/0003_task5_corrective.sql",
  "drizzle/0004_task6_auth.sql",
  "drizzle/0005_task11_upload_session_metadata.sql",
  "drizzle/0006_task11_import_job_lifecycle.sql",
  "drizzle/0007_task11_review_repairs.sql",
  "drizzle/0008_task12_foundations.sql",
  "drizzle/0009_task12_search_analysis.sql",
  "drizzle/0010_task12_corrections.sql",
] as const;

function withDatabase(url: string, database: string) {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

async function applyMigrationFile(sql: Sql, path: string) {
  const statements = readFileSync(path, "utf8")
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter(Boolean);
  for (const statement of statements) await sql.unsafe(statement);
}

async function waitForLock(sql: Sql, pid: number) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const [activity] = await sql<
      { wait_event_type: string | null; state: string }[]
    >`
      SELECT wait_event_type, state
      FROM pg_stat_activity
      WHERE pid = ${pid}
    `;
    if (activity?.wait_event_type === "Lock") return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(
    "The concurrent place update did not wait for the workspace lock.",
  );
}

liveDescribe("Task 18 forward migration on PostgreSQL 18", () => {
  const temporaryDatabase = `humans_task18_${newId().replaceAll("-", "")}`;
  const organizationId = `task18-upgrade-${newId()}`;
  const workspaceId = newId();
  const foreignWorkspaceId = newId();
  const personId = newId();
  let admin: Sql | undefined;
  let upgrade: Sql | undefined;
  let upgradedUrl: string | undefined;

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
    upgradedUrl = withDatabase(databaseUrl, temporaryDatabase);
    upgrade = postgres(upgradedUrl, {
      max: 1,
      onnotice: () => undefined,
      prepare: false,
    });
    for (const path of prerequisiteMigrations)
      await applyMigrationFile(upgrade, path);

    await upgrade`
      INSERT INTO organizations (id, name, slug, created_at)
      VALUES
        (${organizationId}, 'Task 18 upgrade', ${`task18-${newId()}`}, now()),
        (${`${organizationId}-foreign`}, 'Task 18 foreign', ${`task18-foreign-${newId()}`}, now())
    `;
    await upgrade`
      INSERT INTO workspaces (
        id, organization_id, name, created_by, updated_by
      ) VALUES
        (${workspaceId}, ${organizationId}, 'Task 18 upgrade', 'migration-test', 'migration-test'),
        (${foreignWorkspaceId}, ${`${organizationId}-foreign`}, 'Task 18 foreign', 'migration-test', 'migration-test')
    `;
    await upgrade`
      INSERT INTO people (
        id, workspace_id, display_name, created_by, updated_by
      ) VALUES (
        ${personId}, ${workspaceId}, 'Task 18 migration person',
        'migration-test', 'migration-test'
      )
    `;
  }, 60_000);

  afterAll(async () => {
    await upgrade?.end({ timeout: 5 });
    if (admin) {
      await admin.unsafe("SET statement_timeout = '20s'");
      await admin.unsafe(
        `DROP DATABASE IF EXISTS "${temporaryDatabase}" WITH (FORCE)`,
      );
      await admin.end({ timeout: 5 });
    }
  }, 30_000);

  it("remediates legal legacy kinds, hashes, and duplicate primaries before installing constraints", async () => {
    if (!upgrade) throw new Error("Upgrade connection was not initialized");
    const olderContactId = newId();
    const newerContactId = newId();
    const olderContactAssociationId = newId();
    const newerContactAssociationId = newId();
    const olderAddressId = newId();
    const newerAddressId = newId();
    const olderAddressAssociationId = newId();
    const newerAddressAssociationId = newId();

    await upgrade`
      INSERT INTO contact_points (
        id, workspace_id, kind, encrypted_display_value, blind_index,
        blind_index_version, metadata, created_at, updated_at,
        created_by, updated_by
      ) VALUES
        (
          ${olderContactId}, ${workspaceId}, ' pager ', 'legacy:ciphertext:a',
          'legacy-contact-hash-a', NULL, '["legacy-metadata"]'::jsonb,
          now() - interval '2 days', now() - interval '2 days',
          'migration-test', 'migration-test'
        ),
        (
          ${newerContactId}, ${workspaceId}, 'PHONE', 'legacy:ciphertext:b',
          'legacy-contact-hash-b', NULL, '{}'::jsonb,
          now() - interval '1 day', now() - interval '1 day',
          'migration-test', 'migration-test'
        )
    `;
    await upgrade`
      INSERT INTO person_contact_points (
        id, workspace_id, person_id, contact_point_id, usage_kind,
        is_primary, created_at, updated_at, created_by, updated_by
      ) VALUES
        (
          ${olderContactAssociationId}, ${workspaceId}, ${personId},
          ${olderContactId}, 'mobile', true, now() - interval '2 days',
          now() - interval '2 days', 'migration-test', 'migration-test'
        ),
        (
          ${newerContactAssociationId}, ${workspaceId}, ${personId},
          ${newerContactId}, 'mobile', true, now() - interval '1 day',
          now() - interval '1 day', 'migration-test', 'migration-test'
        )
    `;
    await upgrade`
      INSERT INTO addresses (
        id, workspace_id, line1, normalized_hash, created_at, updated_at,
        created_by, updated_by
      ) VALUES
        (
          ${olderAddressId}, ${workspaceId}, 'Legacy address one',
          'legacy-address-value-one', now() - interval '2 days',
          now() - interval '2 days', 'migration-test', 'migration-test'
        ),
        (
          ${newerAddressId}, ${workspaceId}, 'Legacy address two',
          'legacy-address-value-two', now() - interval '1 day',
          now() - interval '1 day', 'migration-test', 'migration-test'
        )
    `;
    await upgrade`
      INSERT INTO person_addresses (
        id, workspace_id, person_id, address_id, address_kind,
        is_primary, created_at, updated_at, created_by, updated_by
      ) VALUES
        (
          ${olderAddressAssociationId}, ${workspaceId}, ${personId},
          ${olderAddressId}, 'home', true, now() - interval '2 days',
          now() - interval '2 days', 'migration-test', 'migration-test'
        ),
        (
          ${newerAddressAssociationId}, ${workspaceId}, ${personId},
          ${newerAddressId}, 'home', true, now() - interval '1 day',
          now() - interval '1 day', 'migration-test', 'migration-test'
        )
    `;

    await expect(
      applyMigrationFile(upgrade, "drizzle/0011_task18_contact_location.sql"),
    ).resolves.toBeUndefined();
    await expect(
      applyMigrationFile(upgrade, "drizzle/0012_task18_completion.sql"),
    ).resolves.toBeUndefined();
    const [installed0012CycleFunction] = await upgrade<
      { definition: string }[]
    >`
      SELECT pg_get_functiondef('public.prevent_place_parent_cycle()'::regprocedure)
        AS definition
    `;
    expect(installed0012CycleFunction?.definition).toContain("FOR UPDATE");

    await expect(
      applyMigrationFile(upgrade, "drizzle/0013_task18_lock_order.sql"),
    ).resolves.toBeUndefined();
    const [upgradedCycleFunction] = await upgrade<{ definition: string }[]>`
      SELECT pg_get_functiondef('public.prevent_place_parent_cycle()'::regprocedure)
        AS definition
    `;
    expect(upgradedCycleFunction?.definition).not.toContain("FOR UPDATE");
    const hierarchyTriggers = await upgrade<
      { name: string; level: string; timing: string }[]
    >`
      SELECT trigger_name AS name, action_orientation AS level,
             action_timing AS timing
      FROM information_schema.triggers
      WHERE event_object_schema = 'public'
        AND event_object_table = 'places'
      ORDER BY trigger_name
    `;
    expect(hierarchyTriggers).toEqual(
      expect.arrayContaining([
        {
          name: "places_hierarchy_serialization_trigger",
          level: "STATEMENT",
          timing: "BEFORE",
        },
        {
          name: "places_parent_cycle_trigger",
          level: "ROW",
          timing: "BEFORE",
        },
      ]),
    );

    const contacts = await upgrade<
      {
        blind_index: string;
        blind_index_version: number | null;
        id: string;
        kind: string;
        metadata: unknown;
      }[]
    >`
      SELECT id, kind, blind_index, blind_index_version, metadata
      FROM contact_points
      WHERE workspace_id = ${workspaceId}
      ORDER BY id
    `;
    expect(contacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          blind_index: "legacy-contact-hash-a",
          blind_index_version: null,
          id: olderContactId,
          kind: "other",
          metadata: {
            task18LegacyKind: " pager ",
            task18LegacyMetadata: ["legacy-metadata"],
          },
        }),
        expect.objectContaining({
          blind_index: "legacy-contact-hash-b",
          blind_index_version: null,
          id: newerContactId,
          kind: "phone",
        }),
      ]),
    );
    const addressHashes = await upgrade<
      {
        id: string;
        normalized_hash: string;
        normalized_hash_version: number | null;
      }[]
    >`
      SELECT id, normalized_hash, normalized_hash_version
      FROM addresses
      WHERE workspace_id = ${workspaceId}
      ORDER BY id
    `;
    expect(addressHashes).toHaveLength(2);
    for (const row of addressHashes) {
      expect(row.normalized_hash).toMatch(/^[0-9a-f]{64}$/u);
      expect(row.normalized_hash).not.toContain("Legacy address");
      expect(row.normalized_hash).not.toContain("legacy-address-value");
      expect(row.normalized_hash_version).toBeNull();
    }
    const contactPrimaries = await upgrade<
      { id: string; is_primary: boolean; version: number }[]
    >`
      SELECT id, is_primary, version
      FROM person_contact_points
      WHERE workspace_id = ${workspaceId} AND person_id = ${personId}
      ORDER BY id
    `;
    expect(contactPrimaries).toEqual(
      expect.arrayContaining([
        { id: olderContactAssociationId, is_primary: false, version: 2 },
        { id: newerContactAssociationId, is_primary: true, version: 1 },
      ]),
    );
    const addressPrimaries = await upgrade<
      { id: string; is_primary: boolean; version: number }[]
    >`
      SELECT id, is_primary, version
      FROM person_addresses
      WHERE workspace_id = ${workspaceId} AND person_id = ${personId}
      ORDER BY id
    `;
    expect(addressPrimaries).toEqual(
      expect.arrayContaining([
        { id: olderAddressAssociationId, is_primary: false, version: 2 },
        { id: newerAddressAssociationId, is_primary: true, version: 1 },
      ]),
    );

    await expect(
      upgrade`
        INSERT INTO contact_points (
          id, workspace_id, kind, encrypted_display_value, blind_index,
          blind_index_version, created_by, updated_by
        ) VALUES (
          ${newId()}, ${workspaceId}, 'pager', 'legacy:ciphertext',
          'legacy', NULL, 'migration-test', 'migration-test'
        )
      `,
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      upgrade`
        INSERT INTO addresses (
          id, workspace_id, line1, normalized_hash, created_by, updated_by
        ) VALUES (
          ${newId()}, ${workspaceId}, 'Invalid hash', 'legacy',
          'migration-test', 'migration-test'
        )
      `,
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      upgrade`
        INSERT INTO person_addresses (
          id, workspace_id, person_id, address_id, address_kind,
          is_primary, created_by, updated_by
        ) VALUES (
          ${newId()}, ${workspaceId}, ${personId}, ${olderAddressId},
          'home', true, 'migration-test', 'migration-test'
        )
      `,
    ).rejects.toMatchObject({ code: "23505" });
  }, 30_000);

  it("rejects self, multi-node, cross-workspace, and concurrent place cycles", async () => {
    if (!upgrade || !upgradedUrl)
      throw new Error("Upgrade connection was not initialized");
    const insertPlace = (input: {
      id: string;
      parentPlaceId?: string | null;
      workspace?: string;
    }) => upgrade!`
      INSERT INTO places (
        id, workspace_id, name, kind, parent_place_id, created_by, updated_by
      ) VALUES (
        ${input.id}, ${input.workspace ?? workspaceId}, ${`Place ${input.id}`},
        'locality', ${input.parentPlaceId ?? null}, 'migration-test', 'migration-test'
      )
    `;

    const selfId = newId();
    await expect(
      insertPlace({ id: selfId, parentPlaceId: selfId }),
    ).rejects.toMatchObject({ code: "23514" });

    const twoA = newId();
    const twoB = newId();
    await insertPlace({ id: twoA });
    await insertPlace({ id: twoB, parentPlaceId: twoA });
    await expect(
      upgrade`
        UPDATE places SET parent_place_id = ${twoB}
        WHERE workspace_id = ${workspaceId} AND id = ${twoA}
      `,
    ).rejects.toMatchObject({ code: "23514" });

    const threeA = newId();
    const threeB = newId();
    const threeC = newId();
    await insertPlace({ id: threeA });
    await insertPlace({ id: threeB, parentPlaceId: threeA });
    await insertPlace({ id: threeC, parentPlaceId: threeB });
    await expect(
      upgrade`
        UPDATE places SET parent_place_id = ${threeC}
        WHERE workspace_id = ${workspaceId} AND id = ${threeA}
      `,
    ).rejects.toMatchObject({ code: "23514" });

    const foreignParent = newId();
    const localChild = newId();
    await insertPlace({ id: foreignParent, workspace: foreignWorkspaceId });
    await insertPlace({ id: localChild });
    await expect(
      upgrade`
        UPDATE places SET parent_place_id = ${foreignParent}
        WHERE workspace_id = ${workspaceId} AND id = ${localChild}
      `,
    ).rejects.toMatchObject({ code: "23503" });

    const concurrentA = newId();
    const concurrentB = newId();
    await insertPlace({ id: concurrentA });
    await insertPlace({ id: concurrentB });
    const first = postgres(upgradedUrl, {
      max: 1,
      onnotice: () => undefined,
      prepare: false,
    });
    const second = postgres(upgradedUrl, {
      max: 1,
      onnotice: () => undefined,
      prepare: false,
    });
    try {
      await first.unsafe("BEGIN");
      await second.unsafe("BEGIN");
      const [secondBackend] = await second<{ pid: number }[]>`
        SELECT pg_backend_pid() AS pid
      `;
      await first`
        UPDATE places SET parent_place_id = ${concurrentB}
        WHERE workspace_id = ${workspaceId} AND id = ${concurrentA}
      `;
      const secondUpdate = second`
        UPDATE places SET parent_place_id = ${concurrentA}
        WHERE workspace_id = ${workspaceId} AND id = ${concurrentB}
      `.then(
        () => null,
        (error: unknown) => error,
      );
      await waitForLock(upgrade, secondBackend!.pid);
      await first.unsafe("COMMIT");
      const secondError = await secondUpdate;
      expect(secondError).toMatchObject({ code: "23514" });
      await second.unsafe("ROLLBACK");
    } finally {
      await first.unsafe("ROLLBACK").catch(() => undefined);
      await second.unsafe("ROLLBACK").catch(() => undefined);
      await first.end({ timeout: 5 });
      await second.end({ timeout: 5 });
    }
  }, 30_000);
});
