// @vitest-environment node

import { existsSync } from "node:fs";

import { beforeAll, describe, expect, it } from "vitest";

import {
  assertAuthSchemaCompatible,
  createSchemaGenerationEnvironment,
  runBetterAuthSchemaCheck,
  type NormalizedAuthSchema,
  type NormalizedColumn,
} from "../../scripts/check-better-auth-schema";

const cloneContract = (contract: NormalizedAuthSchema) =>
  structuredClone(contract);

const syntheticColumn = (): NormalizedColumn => ({
  columnType: "PgText",
  dataType: "string",
  default: undefined,
  hasDefault: false,
  notNull: false,
  primaryKey: false,
  sqlType: "text",
});

describe("Better Auth generated schema drift check", () => {
  let generated: NormalizedAuthSchema;
  let committed: NormalizedAuthSchema;

  beforeAll(async () => {
    const result = await runBetterAuthSchemaCheck();

    generated = result.generated;
    committed = result.committed;

    expect(existsSync(result.temporaryDirectory)).toBe(false);
  }, 30_000);

  it("compares the complete generated contract with exact Humans augmentations", () => {
    expect(Object.keys(generated.tables)).toEqual([
      "accounts",
      "api_keys",
      "invitations",
      "members",
      "organizations",
      "rate_limits",
      "sessions",
      "two_factors",
      "users",
      "verifications",
    ]);
    expect(generated.tables.users.columns.created_at.sqlType).toBe("timestamp");
    expect(committed.tables.users.columns.created_at.sqlType).toBe(
      "timestamp (3) with time zone",
    );
    expect(committed.tables.api_keys.columns.workspace_id).toEqual({
      columnType: "PgUUID",
      dataType: "string",
      default: undefined,
      hasDefault: false,
      notNull: true,
      primaryKey: false,
      sqlType: "uuid",
    });
    expect(() =>
      assertAuthSchemaCompatible(generated, committed),
    ).not.toThrow();
  });

  it("rejects generated fields missing from committed storage", () => {
    const mutated = cloneContract(committed);
    delete mutated.tables.api_keys.columns.permissions;

    expect(() => assertAuthSchemaCompatible(generated, mutated)).toThrow(
      /api_keys\.permissions.*missing/i,
    );
  });

  it("rejects committed fields missing from or added beyond generation", () => {
    const generatedMissing = cloneContract(generated);
    delete generatedMissing.tables.users.columns.email;
    expect(() =>
      assertAuthSchemaCompatible(generatedMissing, committed),
    ).toThrow(/users\.email.*unexpected committed column/i);

    const generatedExtra = cloneContract(generated);
    generatedExtra.tables.users.columns.unexpected = syntheticColumn();
    expect(() => assertAuthSchemaCompatible(generatedExtra, committed)).toThrow(
      /users\.unexpected.*generated column is missing/i,
    );

    const committedExtra = cloneContract(committed);
    committedExtra.tables.users.columns.unexpected = syntheticColumn();
    expect(() => assertAuthSchemaCompatible(generated, committedExtra)).toThrow(
      /users\.unexpected.*unexpected committed column/i,
    );
  });

  it("rejects physical SQL-type drift and nearby allowlist values", () => {
    const arbitraryType = cloneContract(committed);
    arbitraryType.tables.users.columns.email.sqlType = "integer";
    expect(() => assertAuthSchemaCompatible(generated, arbitraryType)).toThrow(
      /users\.email\.sqlType/i,
    );

    const nearbyTimestamp = cloneContract(committed);
    nearbyTimestamp.tables.users.columns.created_at.sqlType =
      "timestamp (6) with time zone";
    expect(() =>
      assertAuthSchemaCompatible(generated, nearbyTimestamp),
    ).toThrow(/users\.created_at\.sqlType/i);

    const nearbyWorkspace = cloneContract(committed);
    nearbyWorkspace.tables.members.columns.workspace_id.sqlType = "text";
    expect(() =>
      assertAuthSchemaCompatible(generated, nearbyWorkspace),
    ).toThrow(/members\.workspace_id|expected allowlisted difference/i);
  });

  it("rejects unallowlisted committed unique keys, indexes, and foreign keys", () => {
    const extraUnique = cloneContract(committed);
    extraUnique.tables.users.uniqueKeys.push({ columns: ["email", "name"] });
    expect(() => assertAuthSchemaCompatible(generated, extraUnique)).toThrow(
      /users.*unexpected committed unique key.*email.*name/i,
    );

    const extraIndex = cloneContract(committed);
    extraIndex.tables.users.indexes.push({
      columns: ["email", "name"],
      method: "btree",
      unique: false,
    });
    expect(() => assertAuthSchemaCompatible(generated, extraIndex)).toThrow(
      /users.*unexpected committed index.*email.*name/i,
    );

    const extraForeignKey = cloneContract(committed);
    extraForeignKey.tables.users.foreignKeys.push({
      columns: ["email"],
      foreignColumns: ["id"],
      foreignTable: "users",
      onDelete: "restrict",
      onUpdate: "no action",
    });
    expect(() =>
      assertAuthSchemaCompatible(generated, extraForeignKey),
    ).toThrow(/users.*unexpected committed foreign key.*email/i);
  });

  it("rejects generated constraints absent from committed storage", () => {
    const generatedUnique = cloneContract(generated);
    generatedUnique.tables.users.uniqueKeys.push({
      columns: ["name", "email"],
    });
    expect(() =>
      assertAuthSchemaCompatible(generatedUnique, committed),
    ).toThrow(/users.*missing generated unique key.*name.*email/i);

    const generatedForeignKey = cloneContract(generated);
    generatedForeignKey.tables.users.foreignKeys.push({
      columns: ["name"],
      foreignColumns: ["id"],
      foreignTable: "users",
      onDelete: "restrict",
      onUpdate: "no action",
    });
    expect(() =>
      assertAuthSchemaCompatible(generatedForeignKey, committed),
    ).toThrow(/users.*missing generated foreign key.*name/i);
  });

  it("requires every exact Humans auth role check augmentation", () => {
    expect(committed.tables.users.checks).toEqual([
      {
        name: "users_global_role_check",
        sql: '"users"."role" IS NULL OR "users"."role" IN (\'user\', \'admin\')',
      },
    ]);
    expect(committed.tables.members.checks).toEqual([
      {
        name: "members_workspace_role_check",
        sql: "\"members\".\"role\" IN ('owner', 'admin', 'analyst', 'contributor', 'viewer')",
      },
    ]);
    expect(committed.tables.invitations.checks).toEqual([
      {
        name: "invitations_workspace_role_check",
        sql: "\"invitations\".\"role\" IS NULL OR \"invitations\".\"role\" IN ('owner', 'admin', 'analyst', 'contributor', 'viewer')",
      },
    ]);

    const missingCheck = cloneContract(committed);
    missingCheck.tables.members.checks = [];
    expect(() => assertAuthSchemaCompatible(generated, missingCheck)).toThrow(
      /members_workspace_role_check|expected allowlisted difference/i,
    );

    const weakenedCheck = cloneContract(committed);
    weakenedCheck.tables.users.checks[0]!.sql =
      '"users"."role" IS NULL OR "users"."role" IN (\'user\', \'admin\', \'superadmin\')';
    expect(() => assertAuthSchemaCompatible(generated, weakenedCheck)).toThrow(
      /users.*unexpected committed check|expected allowlisted difference/i,
    );
  });

  it("preserves ordered B-tree index columns", () => {
    const generatedWithOrderedIndex = cloneContract(generated);
    const committedWithSwappedIndex = cloneContract(committed);
    generatedWithOrderedIndex.tables.accounts.indexes.push({
      columns: ["provider_id", "account_id"],
      method: "btree",
      unique: false,
    });
    committedWithSwappedIndex.tables.accounts.indexes.push({
      columns: ["account_id", "provider_id"],
      method: "btree",
      unique: false,
    });

    expect(() =>
      assertAuthSchemaCompatible(
        generatedWithOrderedIndex,
        committedWithSwappedIndex,
      ),
    ).toThrow(/accounts.*index.*provider_id.*account_id/i);
  });

  it("requires exact known augmentations instead of broad table exceptions", () => {
    const nearbyUnique = cloneContract(committed);
    const accountIdentity = nearbyUnique.tables.accounts.uniqueKeys.find(
      (key) => key.columns.join(",") === "provider_id,account_id",
    );
    expect(accountIdentity).toBeDefined();
    accountIdentity!.columns.reverse();
    expect(() => assertAuthSchemaCompatible(generated, nearbyUnique)).toThrow(
      /accounts.*unique key|expected allowlisted difference/i,
    );

    const nearbyIndex = cloneContract(committed);
    const sessionExpiry = nearbyIndex.tables.sessions.indexes.find(
      (index) => index.columns.join(",") === "expires_at",
    );
    expect(sessionExpiry).toBeDefined();
    sessionExpiry!.method = "hash";
    expect(() => assertAuthSchemaCompatible(generated, nearbyIndex)).toThrow(
      /sessions.*index|expected allowlisted difference/i,
    );

    const nearbyForeignKey = cloneContract(committed);
    const memberWorkspace = nearbyForeignKey.tables.members.foreignKeys.find(
      (foreignKey) => foreignKey.foreignTable === "workspaces",
    );
    expect(memberWorkspace).toBeDefined();
    memberWorkspace!.onDelete = "restrict";
    expect(() =>
      assertAuthSchemaCompatible(generated, nearbyForeignKey),
    ).toThrow(/members.*foreign key|expected allowlisted difference/i);
  });

  it("does not forward runtime credentials to schema generation", () => {
    expect(
      createSchemaGenerationEnvironment({
        AUTH_SECRET: "runtime-auth-secret",
        DATABASE_URL: "postgresql://runtime-secret",
        HOME: "/safe/home",
        OPENAI_API_KEY: "runtime-openai-key",
        PATH: "/safe/bin",
        REDIS_URL: "redis://runtime-secret",
      }),
    ).toEqual({
      HOME: "/safe/home",
      PATH: "/safe/bin",
    });
  });
});
