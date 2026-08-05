import { getTableName } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import * as schema from "@/db/schema";

type Table = Parameters<typeof getTableConfig>[0];
type Column = {
  default?: unknown;
  notNull?: boolean;
  withTimezone?: boolean;
};

const workspaceTableNames = [
  "aiCitations",
  "aiEphemeralInputs",
  "aiMessages",
  "aiRuns",
  "aiThreads",
  "aiToolCalls",
  "apiKeys",
  "members",
  "evidenceExcerpts",
  "evidenceItems",
  "factEvidence",
  "factTags",
  "notes",
  "personAddresses",
  "personContactPoints",
  "personTags",
  "relationshipEvidence",
  "relationshipTags",
  "sources",
  "tags",
  "factDefinitions",
  "factRelationships",
  "factRevisions",
  "facts",
  "personFieldSelections",
  "extractionRuns",
  "fileVariants",
  "files",
  "importMappings",
  "importRows",
  "imports",
  "uploadSessions",
  "analysisResults",
  "analysisRuns",
  "graphSnapshots",
  "graphViewNodes",
  "graphViews",
  "personMetrics",
  "addresses",
  "contactPoints",
  "locationMutationIdempotency",
  "places",
  "auditEvents",
  "idempotencyKeys",
  "jobs",
  "webhookDeliveries",
  "webhooks",
  "externalRecords",
  "identityCandidates",
  "mergeDecisions",
  "people",
  "personEvents",
  "personIdentifiers",
  "personNames",
  "workspacePrincipals",
  "consentRecords",
  "deletionRequests",
  "relationshipTypes",
  "relationships",
  "embeddings",
  "queryRuns",
  "savedQueries",
  "searchDocuments",
  "accessPolicies",
  "legalHolds",
  "resourceGrants",
  "retentionPolicies",
  "workspaceSettings",
  "workspaceUsage",
] as const satisfies readonly (keyof typeof schema)[];

const versionedTableNames = [
  "addresses",
  "accessPolicies",
  "aiThreads",
  "consentRecords",
  "contactPoints",
  "deletionRequests",
  "evidenceItems",
  "externalRecords",
  "factDefinitions",
  "factRelationships",
  "files",
  "facts",
  "graphViews",
  "identityCandidates",
  "importMappings",
  "imports",
  "legalHolds",
  "mergeDecisions",
  "notes",
  "people",
  "personAddresses",
  "personContactPoints",
  "personEvents",
  "personFieldSelections",
  "personIdentifiers",
  "personNames",
  "places",
  "relationshipTypes",
  "relationships",
  "resourceGrants",
  "retentionPolicies",
  "savedQueries",
  "sources",
  "tags",
  "webhooks",
  "workspaceSettings",
  "workspaceUsage",
  "workspaces",
] as const satisfies readonly (keyof typeof schema)[];

function table(name: keyof typeof schema): Table {
  return schema[name] as unknown as Table;
}

function columnsFor(value: Table): Record<string, Column> {
  return value as unknown as Record<string, Column>;
}

describe("HUM-NFR-003 complete domain schema conventions", () => {
  it("applies workspace identity and application-generated IDs to every workspace table", () => {
    const discoveredWorkspaceTables = Object.entries(schema)
      .filter(
        ([, value]) =>
          value && typeof value === "object" && "workspaceId" in value,
      )
      .map(([name]) => name)
      .sort();
    expect(discoveredWorkspaceTables).toEqual([...workspaceTableNames].sort());

    for (const name of workspaceTableNames) {
      const value = table(name);
      const columns = columnsFor(value);
      const config = getTableConfig(value);
      const identityUnique = config.uniqueConstraints.some((constraint) => {
        const names = constraint.columns.map((column) => column.name);
        return names.includes("workspace_id") && names.includes("id");
      });

      expect(columns.workspaceId?.notNull, `${name}.workspaceId`).toBe(true);
      expect(columns.id?.default, `${name}.id`).toBeUndefined();
      expect(
        identityUnique || name === "aiEphemeralInputs",
        `${name} needs a workspace-leading identity constraint`,
      ).toBe(true);

      for (const [columnName, column] of Object.entries(columns)) {
        if (columnName.endsWith("At")) {
          expect(column.withTimezone, `${name}.${columnName}`).toBe(true);
        }
      }
    }
  });

  it("requires versioned mutable records to carry actor and soft-delete metadata", () => {
    const discoveredVersionedTables = Object.entries(schema)
      .filter(
        ([, value]) => value && typeof value === "object" && "version" in value,
      )
      .map(([name]) => name)
      .sort();
    expect(discoveredVersionedTables).toEqual([...versionedTableNames].sort());

    for (const name of versionedTableNames) {
      const columns = columnsFor(table(name));
      expect(columns.version?.notNull, `${name}.version`).toBe(true);
      expect(columns.createdBy?.notNull, `${name}.createdBy`).toBe(true);
      expect(columns.updatedBy?.notNull, `${name}.updatedBy`).toBe(true);
      expect(columns.createdAt?.withTimezone, `${name}.createdAt`).toBe(true);
      expect(columns.updatedAt?.withTimezone, `${name}.updatedAt`).toBe(true);
      if (columns.deletedAt) {
        expect(columns.deletedAt.withTimezone, `${name}.deletedAt`).toBe(true);
        expect(columns.deletedBy, `${name}.deletedBy`).toBeDefined();
      }
    }
  });

  it("keeps cross-domain foreign references workspace-leading", () => {
    const workspaceTableSet = new Set([
      ...workspaceTableNames.map((name) => getTableName(table(name))),
      getTableName(schema.workspaces),
    ]);

    for (const name of workspaceTableNames) {
      const config = getTableConfig(table(name));
      for (const foreignKey of config.foreignKeys) {
        const reference = foreignKey.reference();
        if (!workspaceTableSet.has(getTableName(reference.foreignTable))) {
          continue;
        }
        const localColumns = reference.columns.map((column) => column.name);
        const foreignColumns = reference.foreignColumns.map(
          (column) => column.name,
        );
        if (getTableName(reference.foreignTable) === "workspaces") {
          expect(localColumns[0], `${name} workspace binding`).toBe(
            "workspace_id",
          );
          expect(foreignColumns[0], `${name} workspace binding`).toBe("id");
        } else {
          expect(localColumns[0], `${name} ${foreignKey.getName()}`).toBe(
            "workspace_id",
          );
          expect(foreignColumns[0], `${name} ${foreignKey.getName()}`).toBe(
            "workspace_id",
          );
        }
      }
    }
  });

  it("keeps revisions append-only and identifiable by workspace", () => {
    const revisions = columnsFor(table("factRevisions"));
    const config = getTableConfig(table("factRevisions"));
    expect(revisions.createdAt?.withTimezone).toBe(true);
    expect(revisions.createdBy?.notNull).toBe(true);
    expect(revisions.updatedAt).toBeUndefined();
    expect(revisions.deletedAt).toBeUndefined();
    expect(
      config.uniqueConstraints.some((constraint) =>
        constraint.columns.some((column) => column.name === "workspace_id"),
      ),
    ).toBe(true);
  });
});
