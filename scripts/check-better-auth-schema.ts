import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { is } from "drizzle-orm";
import { getTableConfig, PgDialect, PgTable } from "drizzle-orm/pg-core";

import * as committedAuthSchema from "../src/db/schema/auth";

type PrimitiveDefault = boolean | number | string | null;

export type NormalizedColumn = {
  columnType: string;
  dataType: string;
  default?: PrimitiveDefault;
  hasDefault: boolean;
  notNull: boolean;
  primaryKey: boolean;
  sqlType: string;
};

export type NormalizedForeignKey = {
  columns: string[];
  foreignColumns: string[];
  foreignTable: string;
  onDelete: string;
  onUpdate: string;
};

export type NormalizedIndex = {
  columns: string[];
  method: string;
  unique: boolean;
};

export type NormalizedCheck = {
  name: string;
  sql: string;
};

export type NormalizedUniqueKey = {
  columns: string[];
};

type NormalizedTable = {
  checks: NormalizedCheck[];
  columns: Record<string, NormalizedColumn>;
  foreignKeys: NormalizedForeignKey[];
  indexes: NormalizedIndex[];
  uniqueKeys: NormalizedUniqueKey[];
};

export type NormalizedAuthSchema = {
  tables: Record<string, NormalizedTable>;
};

type SchemaModule = Record<string, unknown>;
type ColumnPath = `${string}.${string}`;
type ColumnProperty = keyof NormalizedColumn;
type ColumnPropertyAllowance = {
  committed: NormalizedColumn[ColumnProperty];
  generated: NormalizedColumn[ColumnProperty];
  id: string;
  path: ColumnPath;
  property: ColumnProperty;
  reason: string;
};
type CommittedColumnAllowance = {
  column: NormalizedColumn;
  id: string;
  path: ColumnPath;
  reason: string;
};
type ContractAllowance<T> = {
  id: string;
  reason: string;
  table: string;
  value: T;
};

const executeFile = promisify(execFile);
const dialect = new PgDialect();
const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));

const generationEnvironmentKeys = [
  "CI",
  "FORCE_COLOR",
  "HOME",
  "NO_COLOR",
  "PATH",
  "PNPM_HOME",
  "SYSTEMROOT",
  "TEMP",
  "TMP",
  "TMPDIR",
] as const;

export function createSchemaGenerationEnvironment(
  source: Readonly<Record<string, string | undefined>>,
): Record<string, string | undefined> {
  const isolated: Record<string, string | undefined> = {};

  for (const key of generationEnvironmentKeys) {
    if (source[key] !== undefined) isolated[key] = source[key];
  }

  return isolated;
}

const timestampSqlTypePaths = [
  "accounts.access_token_expires_at",
  "accounts.refresh_token_expires_at",
  "accounts.created_at",
  "accounts.updated_at",
  "api_keys.last_refill_at",
  "api_keys.last_request",
  "api_keys.expires_at",
  "api_keys.created_at",
  "api_keys.updated_at",
  "invitations.expires_at",
  "invitations.created_at",
  "members.created_at",
  "organizations.created_at",
  "sessions.expires_at",
  "sessions.created_at",
  "sessions.updated_at",
  "two_factors.locked_until",
  "users.created_at",
  "users.updated_at",
  "users.ban_expires",
  "verifications.expires_at",
  "verifications.created_at",
  "verifications.updated_at",
] as const satisfies readonly ColumnPath[];

// Every allowed difference is path-, property-, and value-specific. Adding a
// nearby timestamp, changing UUID storage, or changing a default cannot inherit
// one of these exceptions.
const allowedColumnPropertyTransitions: readonly ColumnPropertyAllowance[] = [
  ...timestampSqlTypePaths.map((path) => ({
    committed: "timestamp (3) with time zone",
    generated: "timestamp",
    id: `column:${path}:sqlType`,
    path,
    property: "sqlType" as const,
    reason: "Humans stores auth timestamps at millisecond precision in UTC",
  })),
  {
    committed: "PgUUID",
    generated: "PgText",
    id: "column:members.workspace_id:columnType",
    path: "members.workspace_id",
    property: "columnType",
    reason: "the server-only workspace field is stored as a PostgreSQL UUID",
  },
  {
    committed: "uuid",
    generated: "text",
    id: "column:members.workspace_id:sqlType",
    path: "members.workspace_id",
    property: "sqlType",
    reason: "the server-only workspace field is stored as a PostgreSQL UUID",
  },
  {
    committed: "viewer",
    generated: "member",
    id: "column:members.role:default",
    path: "members.role",
    property: "default",
    reason: "Humans fails new workspace memberships closed to viewer",
  },
  {
    committed: "now()",
    generated: undefined,
    id: "column:accounts.updated_at:default",
    path: "accounts.updated_at",
    property: "default",
    reason:
      "Humans gives adapter-created account timestamps a database default",
  },
  {
    committed: "now()",
    generated: undefined,
    id: "column:sessions.updated_at:default",
    path: "sessions.updated_at",
    property: "default",
    reason:
      "Humans gives adapter-created session timestamps a database default",
  },
] satisfies readonly ColumnPropertyAllowance[];

const allowedCommittedColumns = [
  {
    column: {
      columnType: "PgUUID",
      dataType: "string",
      default: undefined,
      hasDefault: false,
      notNull: true,
      primaryKey: false,
      sqlType: "uuid",
    },
    id: "column:api_keys.workspace_id",
    path: "api_keys.workspace_id",
    reason: "Humans derives organization API-key tenancy in PostgreSQL",
  },
] as const satisfies readonly CommittedColumnAllowance[];

const allowedCommittedUniqueKeys = [
  {
    id: "unique:accounts.provider_id,account_id",
    reason: "provider account identities are unique",
    table: "accounts",
    value: { columns: ["provider_id", "account_id"] },
  },
  {
    id: "unique:api_keys.key",
    reason: "API-key lookup values are unique rather than merely indexed",
    table: "api_keys",
    value: { columns: ["key"] },
  },
  {
    id: "unique:api_keys.workspace_id,id",
    reason: "tenant-safe API-key foreign keys require a composite target",
    table: "api_keys",
    value: { columns: ["workspace_id", "id"] },
  },
  {
    id: "unique:members.organization_id,user_id",
    reason: "one membership is allowed per user and organization",
    table: "members",
    value: { columns: ["organization_id", "user_id"] },
  },
  {
    id: "unique:invitations.organization_id,normalized_email",
    reason:
      "Humans permits at most one pending invitation for a normalized workspace recipient",
    table: "invitations",
    value: {
      columns: ["organization_id", 'lower("invitations"."email")'],
    },
  },
  {
    id: "unique:members.workspace_id,id",
    reason: "tenant-safe member foreign keys require a composite target",
    table: "members",
    value: { columns: ["workspace_id", "id"] },
  },
  {
    id: "unique:members.workspace_id,user_id",
    reason: "tenant-safe user attribution requires a composite target",
    table: "members",
    value: { columns: ["workspace_id", "user_id"] },
  },
  {
    id: "unique:sessions.user_id,id",
    reason: "tenant-safe audit session validation requires a composite target",
    table: "sessions",
    value: { columns: ["user_id", "id"] },
  },
] as const satisfies readonly ContractAllowance<NormalizedUniqueKey>[];

const allowedCommittedIndexes = [
  {
    id: "index:invitations:btree:organization_id,normalized_email:unique",
    reason:
      "Humans serializes pending invitation issue by normalized workspace recipient",
    table: "invitations",
    value: {
      columns: ["organization_id", 'lower("invitations"."email")'],
      method: "btree",
      unique: true,
    },
  },
  {
    id: "index:sessions:btree:expires_at",
    reason: "session expiry cleanup is indexed",
    table: "sessions",
    value: { columns: ["expires_at"], method: "btree", unique: false },
  },
  {
    id: "index:verifications:btree:expires_at",
    reason: "verification expiry cleanup is indexed",
    table: "verifications",
    value: { columns: ["expires_at"], method: "btree", unique: false },
  },
] as const satisfies readonly ContractAllowance<NormalizedIndex>[];

const allowedGeneratedOnlyIndexes = [
  {
    id: "generated-index:api_keys:btree:key",
    reason: "Humans replaces Better Auth's key index with exact key uniqueness",
    table: "api_keys",
    value: { columns: ["key"], method: "btree", unique: false },
  },
  {
    id: "generated-index:organizations:btree:slug:unique",
    reason: "Humans expresses slug uniqueness as a named unique constraint",
    table: "organizations",
    value: { columns: ["slug"], method: "btree", unique: true },
  },
] as const satisfies readonly ContractAllowance<NormalizedIndex>[];

const allowedCommittedForeignKeys = [
  {
    id: "fk:api_keys.reference_id:organizations.id",
    reason: "organization-owned API keys cannot outlive their organization",
    table: "api_keys",
    value: {
      columns: ["reference_id"],
      foreignColumns: ["id"],
      foreignTable: "organizations",
      onDelete: "cascade",
      onUpdate: "no action",
    },
  },
  {
    id: "fk:api_keys.workspace_id,reference_id:workspaces.id,organization_id",
    reason: "API-key workspace identity must match its organization",
    table: "api_keys",
    value: {
      columns: ["workspace_id", "reference_id"],
      foreignColumns: ["id", "organization_id"],
      foreignTable: "workspaces",
      onDelete: "cascade",
      onUpdate: "no action",
    },
  },
  {
    id: "fk:members.workspace_id,organization_id:workspaces.id,organization_id",
    reason: "member workspace identity must match its organization",
    table: "members",
    value: {
      columns: ["workspace_id", "organization_id"],
      foreignColumns: ["id", "organization_id"],
      foreignTable: "workspaces",
      onDelete: "cascade",
      onUpdate: "no action",
    },
  },
] as const satisfies readonly ContractAllowance<NormalizedForeignKey>[];

const allowedCommittedChecks = [
  {
    id: "check:invitations_workspace_role_check",
    reason: "workspace invitations accept only the five exact workspace roles",
    table: "invitations",
    value: {
      name: "invitations_workspace_role_check",
      sql: "\"invitations\".\"role\" IS NULL OR \"invitations\".\"role\" IN ('owner', 'admin', 'analyst', 'contributor', 'viewer')",
    },
  },
  {
    id: "check:members_workspace_role_check",
    reason: "workspace members have exactly one of the five workspace roles",
    table: "members",
    value: {
      name: "members_workspace_role_check",
      sql: "\"members\".\"role\" IN ('owner', 'admin', 'analyst', 'contributor', 'viewer')",
    },
  },
  {
    id: "check:users_global_role_check",
    reason: "global Better Auth roles are limited to user and admin",
    table: "users",
    value: {
      name: "users_global_role_check",
      sql: '"users"."role" IS NULL OR "users"."role" IN (\'user\', \'admin\')',
    },
  },
] as const satisfies readonly ContractAllowance<NormalizedCheck>[];

const allAllowances = [
  ...allowedColumnPropertyTransitions,
  ...allowedCommittedColumns,
  ...allowedCommittedUniqueKeys,
  ...allowedCommittedIndexes,
  ...allowedGeneratedOnlyIndexes,
  ...allowedCommittedForeignKeys,
  ...allowedCommittedChecks,
] as const;

function normalizeDefault(value: unknown): PrimitiveDefault | undefined {
  if (
    value === undefined ||
    value === null ||
    typeof value === "boolean" ||
    typeof value === "number" ||
    typeof value === "string"
  ) {
    return value;
  }

  if (value instanceof Date) return value.toISOString();

  try {
    return dialect
      .sqlToQuery(value as never)
      .sql.replaceAll(/\s+/g, " ")
      .trim();
  } catch {
    throw new Error("Better Auth schema contains an unsupported default value");
  }
}

function signature(value: object): string {
  return JSON.stringify(value);
}

function normalizeCollection<T extends object>(values: T[]): T[] {
  return [...values].sort((left, right) =>
    signature(left).localeCompare(signature(right)),
  );
}

function normalizeUniqueKeys(
  values: NormalizedUniqueKey[],
): NormalizedUniqueKey[] {
  // Drizzle can expose one unique key twice when a generated table declares
  // both column.unique() and a uniqueIndex() for the same ordered columns.
  // Normalize that duplicate metadata into one logical uniqueness contract.
  return normalizeCollection([
    ...new Map(values.map((value) => [signature(value), value])).values(),
  ]);
}

function normalizeIndexColumn(column: unknown): string {
  if (
    typeof column === "object" &&
    column !== null &&
    "name" in column &&
    typeof column.name === "string"
  ) {
    return column.name;
  }

  return dialect
    .sqlToQuery(column as never)
    .sql.replaceAll(/\s+/g, " ")
    .trim();
}

function normalizeSql(value: unknown): string {
  return dialect
    .sqlToQuery(value as never)
    .sql.replaceAll(/\s+/g, " ")
    .trim();
}

function normalizeAuthSchema(schema: SchemaModule): NormalizedAuthSchema {
  const tables: Array<[string, NormalizedTable]> = [];

  for (const value of Object.values(schema)) {
    if (!is(value, PgTable)) continue;

    const config = getTableConfig(value);
    const indexes = normalizeCollection(
      config.indexes.map((index) => ({
        columns: index.config.columns.map(normalizeIndexColumn),
        method: index.config.method ?? "btree",
        unique: Boolean(index.config.unique),
      })),
    );
    const uniqueKeys: NormalizedUniqueKey[] = [];

    for (const column of config.columns) {
      if (column.isUnique) uniqueKeys.push({ columns: [column.name] });
    }
    for (const constraint of config.uniqueConstraints) {
      uniqueKeys.push({
        columns: constraint.columns.map((column) => column.name),
      });
    }
    for (const index of indexes) {
      if (index.unique) uniqueKeys.push({ columns: [...index.columns] });
    }

    const columns = Object.fromEntries(
      config.columns
        .map(
          (column) =>
            [
              column.name,
              {
                columnType: column.columnType,
                dataType: column.dataType,
                default: normalizeDefault(column.default),
                hasDefault: column.hasDefault,
                notNull: column.notNull,
                primaryKey: column.primary,
                sqlType: column.getSQLType(),
              },
            ] as const,
        )
        .sort(([left], [right]) => left.localeCompare(right)),
    );

    const foreignKeys = normalizeCollection(
      config.foreignKeys.map((foreignKey) => {
        const reference = foreignKey.reference();
        return {
          columns: reference.columns.map((column) => column.name),
          foreignColumns: reference.foreignColumns.map((column) => column.name),
          foreignTable: getTableConfig(reference.foreignTable).name,
          onDelete: foreignKey.onDelete ?? "no action",
          onUpdate: foreignKey.onUpdate ?? "no action",
        };
      }),
    );
    const checks = normalizeCollection(
      config.checks.map((constraint) => ({
        name: constraint.name,
        sql: normalizeSql(constraint.value),
      })),
    );

    tables.push([
      config.name,
      {
        checks,
        columns,
        foreignKeys,
        indexes,
        uniqueKeys: normalizeUniqueKeys(uniqueKeys),
      },
    ]);
  }

  tables.sort(([left], [right]) => left.localeCompare(right));
  return { tables: Object.fromEntries(tables) };
}

function sameColumn(left: NormalizedColumn, right: NormalizedColumn): boolean {
  return (Object.keys(left) as ColumnProperty[]).every((property) =>
    Object.is(left[property], right[property]),
  );
}

function findContractAllowance<T extends object>(
  allowances: readonly ContractAllowance<T>[],
  consumed: ReadonlySet<string>,
  table: string,
  value: T,
): ContractAllowance<T> | undefined {
  const valueSignature = signature(value);
  return allowances.find(
    (allowance) =>
      !consumed.has(allowance.id) &&
      allowance.table === table &&
      signature(allowance.value) === valueSignature,
  );
}

function compareContractCollection<T extends object>(options: {
  committed: readonly T[];
  committedAllowances: readonly ContractAllowance<T>[];
  consumed: Set<string>;
  generated: readonly T[];
  generatedAllowances?: readonly ContractAllowance<T>[];
  kind: string;
  table: string;
}): string[] {
  const drift: string[] = [];
  const unmatchedCommitted = [...options.committed];

  for (const value of options.generated) {
    const valueSignature = signature(value);
    const matchIndex = unmatchedCommitted.findIndex(
      (candidate) => signature(candidate) === valueSignature,
    );
    if (matchIndex >= 0) {
      unmatchedCommitted.splice(matchIndex, 1);
      continue;
    }
    const allowance = findContractAllowance(
      options.generatedAllowances ?? [],
      options.consumed,
      options.table,
      value,
    );
    if (allowance) options.consumed.add(allowance.id);
    else
      drift.push(
        `${options.table}: missing generated ${options.kind} ${signature(value)}`,
      );
  }

  for (const value of unmatchedCommitted) {
    const allowance = findContractAllowance(
      options.committedAllowances,
      options.consumed,
      options.table,
      value,
    );
    if (allowance) options.consumed.add(allowance.id);
    else
      drift.push(
        `${options.table}: unexpected committed ${options.kind} ${signature(value)}`,
      );
  }

  return drift;
}

export function assertAuthSchemaCompatible(
  generated: NormalizedAuthSchema,
  committed: NormalizedAuthSchema,
): void {
  const consumed = new Set<string>();
  const drift: string[] = [];
  const tableNames = new Set([
    ...Object.keys(generated.tables),
    ...Object.keys(committed.tables),
  ]);

  for (const tableName of [...tableNames].sort()) {
    const generatedTable = generated.tables[tableName];
    const committedTable = committed.tables[tableName];
    if (!generatedTable) {
      drift.push(`${tableName}: unexpected committed auth table`);
      continue;
    }
    if (!committedTable) {
      drift.push(`${tableName}: generated auth table is missing`);
      continue;
    }

    const columnNames = new Set([
      ...Object.keys(generatedTable.columns),
      ...Object.keys(committedTable.columns),
    ]);
    for (const columnName of [...columnNames].sort()) {
      const path = `${tableName}.${columnName}` as ColumnPath;
      const generatedColumn = generatedTable.columns[columnName];
      const committedColumn = committedTable.columns[columnName];

      if (!generatedColumn && committedColumn) {
        const allowance = allowedCommittedColumns.find(
          (candidate) =>
            candidate.path === path &&
            sameColumn(candidate.column, committedColumn),
        );
        if (allowance) consumed.add(allowance.id);
        else drift.push(`${path}: unexpected committed column`);
        continue;
      }
      if (generatedColumn && !committedColumn) {
        drift.push(`${path}: generated column is missing`);
        continue;
      }
      if (!generatedColumn || !committedColumn) continue;

      for (const property of Object.keys(generatedColumn) as ColumnProperty[]) {
        if (Object.is(generatedColumn[property], committedColumn[property])) {
          continue;
        }
        const allowance = allowedColumnPropertyTransitions.find(
          (candidate) =>
            candidate.path === path &&
            candidate.property === property &&
            Object.is(candidate.generated, generatedColumn[property]) &&
            Object.is(candidate.committed, committedColumn[property]),
        );
        if (allowance) consumed.add(allowance.id);
        else
          drift.push(
            `${path}.${property}: expected ${JSON.stringify(generatedColumn[property])}, received ${JSON.stringify(committedColumn[property])}`,
          );
      }
    }

    drift.push(
      ...compareContractCollection({
        committed: committedTable.checks,
        committedAllowances: allowedCommittedChecks,
        consumed,
        generated: generatedTable.checks,
        kind: "check",
        table: tableName,
      }),
      ...compareContractCollection({
        committed: committedTable.uniqueKeys,
        committedAllowances: allowedCommittedUniqueKeys,
        consumed,
        generated: generatedTable.uniqueKeys,
        kind: "unique key",
        table: tableName,
      }),
      ...compareContractCollection({
        committed: committedTable.indexes,
        committedAllowances: allowedCommittedIndexes,
        consumed,
        generated: generatedTable.indexes,
        generatedAllowances: allowedGeneratedOnlyIndexes,
        kind: "index",
        table: tableName,
      }),
      ...compareContractCollection({
        committed: committedTable.foreignKeys,
        committedAllowances: allowedCommittedForeignKeys,
        consumed,
        generated: generatedTable.foreignKeys,
        kind: "foreign key",
        table: tableName,
      }),
    );
  }

  for (const allowance of allAllowances) {
    if (!consumed.has(allowance.id)) {
      drift.push(
        `expected allowlisted difference ${allowance.id} is absent (${allowance.reason})`,
      );
    }
  }

  if (drift.length > 0) {
    throw new Error(
      `Better Auth schema drift detected:\n- ${drift.sort().join("\n- ")}`,
    );
  }
}

async function generateSchema(outputPath: string): Promise<void> {
  await executeFile(
    "pnpm",
    [
      "exec",
      "auth",
      "generate",
      "--config",
      "scripts/better-auth-schema.ts",
      "--output",
      outputPath,
      "--yes",
    ],
    {
      cwd: repositoryRoot,
      env: createSchemaGenerationEnvironment(process.env) as NodeJS.ProcessEnv,
      maxBuffer: 10 * 1024 * 1024,
    },
  );
}

export async function runBetterAuthSchemaCheck(): Promise<{
  committed: NormalizedAuthSchema;
  generated: NormalizedAuthSchema;
  temporaryDirectory: string;
}> {
  const temporaryRoot = join(repositoryRoot, ".tmp");
  await mkdir(temporaryRoot, { recursive: true });
  const temporaryDirectory = await mkdtemp(
    join(temporaryRoot, "better-auth-schema-check-"),
  );
  const generatedPath = join(temporaryDirectory, "better-auth-schema.ts");

  try {
    await generateSchema(generatedPath);
    const generatedModule = (await import(
      `${pathToFileURL(generatedPath).href}?generated=${Date.now()}`
    )) as SchemaModule;
    const generated = normalizeAuthSchema(generatedModule);
    const committed = normalizeAuthSchema(committedAuthSchema);

    assertAuthSchemaCompatible(generated, committed);
    return { committed, generated, temporaryDirectory };
  } finally {
    await rm(temporaryDirectory, { force: true, recursive: true });
  }
}

const invokedPath = process.argv[1]
  ? pathToFileURL(process.argv[1]).href
  : pathToFileURL(join(tmpdir(), "not-invoked")).href;

if (import.meta.url === invokedPath) {
  runBetterAuthSchemaCheck()
    .then(() => {
      console.log("Better Auth generated schema matches the committed schema.");
    })
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    });
}
