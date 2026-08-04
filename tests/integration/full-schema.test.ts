import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import * as schema from "@/db/schema";

const requiredTables = [
  "contactPoints",
  "personContactPoints",
  "places",
  "addresses",
  "personAddresses",
  "relationshipTypes",
  "relationships",
  "relationshipEvidence",
  "relationshipTags",
  "sources",
  "evidenceItems",
  "evidenceExcerpts",
  "notes",
  "tags",
  "personTags",
  "factEvidence",
  "factTags",
  "files",
  "fileVariants",
  "uploadSessions",
  "imports",
  "importMappings",
  "importRows",
  "extractionRuns",
  "searchDocuments",
  "embeddings",
  "savedQueries",
  "queryRuns",
  "graphViews",
  "graphViewNodes",
  "graphSnapshots",
  "analysisRuns",
  "analysisResults",
  "personMetrics",
  "aiThreads",
  "aiMessages",
  "aiRuns",
  "aiToolCalls",
  "aiCitations",
  "jobs",
  "auditEvents",
  "idempotencyKeys",
  "webhooks",
  "webhookDeliveries",
] as const;

describe("approved schema surface", () => {
  it.each(requiredTables)("exports %s", (name) => {
    expect(schema).toHaveProperty(name);
  });

  it.each(requiredTables)("scopes %s to a required workspace", (name) => {
    const table = schema[name] as (typeof schema)[keyof typeof schema] & {
      workspaceId?: { notNull: boolean };
    };

    expect(table.workspaceId?.notNull).toBe(true);
    expect(
      getTableConfig(table as Parameters<typeof getTableConfig>[0])
        .uniqueConstraints.map((constraint) => constraint.name)
        .some(
          (constraintName) =>
            constraintName?.endsWith("workspace_id_unique") === true,
        ),
    ).toBe(true);
  });

  it("persists required upload-session display metadata", () => {
    const uploadSession =
      schema.uploadSessions as typeof schema.uploadSessions & {
        originalName?: { notNull: boolean };
        sensitivity?: { default: unknown; notNull: boolean };
      };

    expect(Object.keys(uploadSession)).toEqual(
      expect.arrayContaining(["originalName", "sensitivity"]),
    );
    expect(uploadSession.originalName?.notNull).toBe(true);
    expect(uploadSession.sensitivity?.notNull).toBe(true);
    expect(uploadSession.sensitivity?.default).toBe("internal");
    expect(
      getTableConfig(schema.uploadSessions).checks.map((check) => check.name),
    ).toContain("upload_sessions_original_name_bytes_check");
  });

  it("keeps optional database features out of the portable migration", async () => {
    const { readdir, readFile } = await import("node:fs/promises");
    const migrationFiles = (await readdir("drizzle"))
      .filter((file) => file.endsWith(".sql"))
      .sort();
    const migration = (
      await Promise.all(
        migrationFiles.map((file) => readFile(`drizzle/${file}`, "utf8")),
      )
    ).join("\n");

    expect(migration).not.toMatch(/CREATE EXTENSION/i);
    expect(migration).not.toMatch(/\bvector\s*\(/i);
    expect(migration).not.toMatch(/\bgeography\s*\(/i);
  });

  it("provides an explicit deterministic seed without default credentials", async () => {
    const { readFile } = await import("node:fs/promises");
    const [packageJson, seed, seedGuard] = await Promise.all([
      readFile("package.json", "utf8"),
      readFile("src/db/seed.ts", "utf8"),
      readFile("src/db/seed-guard.ts", "utf8"),
    ]);

    expect(JSON.parse(packageJson).scripts["db:seed"]).toBe(
      "tsx src/db/seed.ts",
    );
    expect(seedGuard).toContain("DATABASE_URL is required");
    expect(seedGuard).toContain("ALLOW_DATABASE_SEED=true");
    expect(seed).toContain("Ada Lovelace");
    expect(seed).toContain("ON CONFLICT");
    expect(seed).not.toContain("postgresql://humans:humans");
  });

  it("indexes the durable operational and security review paths", () => {
    const indexNames = [schema.files, schema.jobs, schema.auditEvents].flatMap(
      (table) =>
        getTableConfig(table).indexes.map((index) => index.config.name),
    );

    expect(indexNames).toEqual(
      expect.arrayContaining([
        "files_workspace_quarantine_idx",
        "jobs_workspace_claim_idx",
        "audit_events_workspace_resource_idx",
      ]),
    );
  });

  it("uses PostgreSQL's portable full-text type without an extension", () => {
    expect(schema.searchDocuments.searchVector.getSQLType()).toBe("tsvector");
  });

  it("stores protected domain values and redacted audit data without plaintext fields", () => {
    expect(Object.keys(schema.contactPoints)).toContain(
      "encryptedDisplayValue",
    );
    expect(Object.keys(schema.aiMessages)).toContain("encryptedContent");
    expect(Object.keys(schema.jobs)).toContain("encryptedPayload");
    expect(Object.keys(schema.webhooks)).toContain("encryptedSecret");
    expect(Object.keys(schema.auditEvents)).toContain("redactedDiff");
    expect(Object.keys(schema.aiMessages)).not.toContain("content");
    expect(Object.keys(schema.jobs)).not.toContain("payload");
    expect(Object.keys(schema.webhooks)).not.toContain("secret");
    expect(Object.keys(schema.auditEvents)).not.toContain("diff");
  });
});
