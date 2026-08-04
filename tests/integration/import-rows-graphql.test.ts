// @vitest-environment node

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import { newId } from "@/db/id";
import { files, importRows, imports } from "@/db/schema/files";
import { accessPolicies, resourceGrants } from "@/db/schema/workspaces";

import { expectGraphQLError } from "../support/graphql";
import { ResearchFixture } from "../support/research-fixture";

const liveDescribe = process.env.TEST_DATABASE_URL ? describe : describe.skip;

const IMPORT_ROWS_QUERY = /* GraphQL */ `
  query ImportRows($importId: UUID!, $first: Int, $after: String) {
    importRows(importId: $importId, first: $first, after: $after) {
      nodes {
        id
        rowNumber
        state
        normalizedPayload
        issues {
          code
          message
        }
        resultReferences
      }
      pageInfo {
        endCursor
        hasNextPage
      }
    }
  }
`;

type ImportRowsResult = {
  importRows: {
    nodes: Array<{
      id: string;
      issues: Array<{ code: string; message: string }>;
      normalizedPayload: unknown;
      resultReferences: string[];
      rowNumber: number;
      state: string;
    }>;
    pageInfo: { endCursor: string | null; hasNextPage: boolean };
  };
};

liveDescribe("import row GraphQL diagnostics", () => {
  let fixture: ResearchFixture;

  beforeAll(() => {
    fixture = new ResearchFixture();
  });
  beforeEach(async () => fixture.reset());
  afterAll(async () => fixture.close());

  async function seedImportRows(
    actor: Awaited<ReturnType<ResearchFixture["createActor"]>>,
  ) {
    const fileId = newId();
    const importId = newId();
    const generation = 3;
    await fixture.database.insert(files).values({
      id: fileId,
      workspaceId: actor.workspaceId,
      storageProvider: "minio",
      storageBucket: "private",
      storageKey: `imports/${fileId}`,
      originalName: "diagnostics.csv",
      mediaType: "text/csv",
      detectedType: "text/csv",
      byteSize: 12,
      checksum: `sha256:${"ab".repeat(32)}`,
      quarantineState: "available",
      scanState: "not_required",
      ocrState: "not_requested",
      extractionState: "not_requested",
      uploadedBy: actor.userId,
      createdBy: actor.userId,
      updatedBy: actor.userId,
    });
    await fixture.database.insert(imports).values({
      id: importId,
      workspaceId: actor.workspaceId,
      fileId,
      format: "CSV",
      state: "preview_ready",
      mapping: {},
      idempotencyKey: `prepare-${importId}`,
      stagingGeneration: generation,
      totalRows: 3,
      acceptedRows: 2,
      rejectedRows: 1,
      createdBy: actor.userId,
      updatedBy: actor.userId,
    });
    const resultId = newId();
    const rows = [1, 2, 3].map((rowNumber) => ({
      id: newId(),
      workspaceId: actor.workspaceId,
      importId,
      stagingGeneration: generation,
      rowNumber,
      sourceHash: `sha256:${String(rowNumber).padStart(64, "0")}`,
      normalizedPayload: { displayName: `Person ${rowNumber}` },
      resultReferences: rowNumber === 2 ? [resultId] : [],
      validationErrors:
        rowNumber === 3
          ? [{ code: "MISSING_NAME", message: "Name is required." }]
          : [],
      state: rowNumber === 3 ? "rejected" : "pending",
      createdBy: actor.userId,
      updatedBy: actor.userId,
    }));
    await fixture.database.insert(importRows).values([
      ...rows,
      {
        ...rows[0]!,
        id: newId(),
        stagingGeneration: generation - 1,
        normalizedPayload: { displayName: "Obsolete generation" },
      },
    ]);
    return { fileId, importId, rows };
  }

  it("paginates the current staging generation with a stable opaque cursor", async () => {
    const owner = await fixture.createActor();
    const seeded = await seedImportRows(owner);

    const first = await fixture.execute<ImportRowsResult>({
      jar: owner.jar,
      query: IMPORT_ROWS_QUERY,
      variables: { importId: seeded.importId, first: 2 },
    });
    expect(first.body?.errors).toBeUndefined();
    expect(first.body?.data?.importRows.nodes).toMatchObject([
      { id: seeded.rows[0]!.id, rowNumber: 1, state: "pending" },
      {
        id: seeded.rows[1]!.id,
        rowNumber: 2,
        resultReferences: [expect.any(String)],
        state: "pending",
      },
    ]);
    expect(first.body?.data?.importRows.pageInfo).toEqual({
      endCursor: expect.any(String),
      hasNextPage: true,
    });

    const second = await fixture.execute<ImportRowsResult>({
      jar: owner.jar,
      query: IMPORT_ROWS_QUERY,
      variables: {
        importId: seeded.importId,
        first: 2,
        after: first.body?.data?.importRows.pageInfo.endCursor,
      },
    });
    expect(second.body?.errors).toBeUndefined();
    expect(second.body?.data?.importRows).toMatchObject({
      nodes: [
        {
          id: seeded.rows[2]!.id,
          issues: [{ code: "MISSING_NAME", message: "Name is required." }],
          normalizedPayload: { displayName: "Person 3" },
          rowNumber: 3,
          state: "rejected",
        },
      ],
      pageInfo: { endCursor: expect.any(String), hasNextPage: false },
    });
  });

  it("enforces import-read authorization and hides another workspace's import", async () => {
    const owner = await fixture.createActor();
    const seeded = await seedImportRows(owner);
    const personOnlyKey = await fixture.provisionKey(owner, {
      person: ["read"],
    });
    expectGraphQLError(
      await fixture.execute({
        apiKey: personOnlyKey.key,
        origin: null,
        query: IMPORT_ROWS_QUERY,
        variables: { importId: seeded.importId, first: 1 },
      }),
      "FORBIDDEN",
    );

    const outsider = await fixture.createActor();
    expectGraphQLError(
      await fixture.execute({
        jar: outsider.jar,
        query: IMPORT_ROWS_QUERY,
        variables: { importId: seeded.importId, first: 1 },
      }),
      "NOT_FOUND",
    );
  });

  it("applies backing-file sensitivity and grants to import, batch, list, and diagnostics reads", async () => {
    const owner = await fixture.createActor();
    const reader = await fixture.createWorkspaceMember(owner, "viewer");
    const seeded = await seedImportRows(owner);
    await fixture.database
      .update(files)
      .set({ sensitivity: "restricted" })
      .where(eq(files.id, seeded.fileId));

    const importQuery = /* GraphQL */ `
      query Import($id: UUID!) {
        import(id: $id) {
          id
        }
      }
    `;
    const historyQuery = /* GraphQL */ `
      query ImportHistory {
        imports(first: 10) {
          nodes {
            id
          }
        }
      }
    `;

    const hidden = await fixture.execute<{
      import: { id: string } | null;
    }>({
      jar: reader.jar,
      query: importQuery,
      variables: { id: seeded.importId },
    });
    expect(hidden.body?.errors).toBeUndefined();
    expect(hidden.body?.data?.import).toBeNull();

    const hiddenHistory = await fixture.execute<{
      imports: { nodes: Array<{ id: string }> };
    }>({ jar: reader.jar, query: historyQuery });
    expect(hiddenHistory.body?.errors).toBeUndefined();
    expect(hiddenHistory.body?.data?.imports.nodes).toEqual([]);

    expectGraphQLError(
      await fixture.execute({
        jar: reader.jar,
        query: IMPORT_ROWS_QUERY,
        variables: { importId: seeded.importId, first: 1 },
      }),
      "NOT_FOUND",
    );

    const policyId = newId();
    await fixture.database.insert(accessPolicies).values({
      id: policyId,
      workspaceId: owner.workspaceId,
      name: "Restricted import source",
      sensitivityCeiling: "restricted",
      resourceKinds: ["file"],
      state: "active",
      createdBy: owner.principalId,
      updatedBy: owner.principalId,
    });
    await fixture.database.insert(resourceGrants).values({
      id: newId(),
      workspaceId: owner.workspaceId,
      policyId,
      memberId: reader.memberId,
      resourceId: seeded.fileId,
      resourceKind: "file",
      state: "active",
      createdBy: owner.principalId,
      updatedBy: owner.principalId,
    });

    const visible = await fixture.execute<{
      import: { id: string } | null;
    }>({
      jar: reader.jar,
      query: importQuery,
      variables: { id: seeded.importId },
    });
    expect(visible.body?.errors).toBeUndefined();
    expect(visible.body?.data?.import).toEqual({ id: seeded.importId });

    const visibleHistory = await fixture.execute<{
      imports: { nodes: Array<{ id: string }> };
    }>({ jar: reader.jar, query: historyQuery });
    expect(visibleHistory.body?.errors).toBeUndefined();
    expect(visibleHistory.body?.data?.imports.nodes).toEqual([
      { id: seeded.importId },
    ]);

    const visibleDiagnostics = await fixture.execute<ImportRowsResult>({
      jar: reader.jar,
      query: IMPORT_ROWS_QUERY,
      variables: { importId: seeded.importId, first: 1 },
    });
    expect(visibleDiagnostics.body?.errors).toBeUndefined();
    expect(visibleDiagnostics.body?.data?.importRows.nodes).toMatchObject([
      {
        id: seeded.rows[0]?.id,
        normalizedPayload: { displayName: "Person 1" },
      },
    ]);
  });

  it("allows one maximum diagnostics page but rejects an aliased over-budget operation", async () => {
    const owner = await fixture.createActor();
    const seeded = await seedImportRows(owner);
    const supported = await fixture.execute({
      jar: owner.jar,
      query: `query($id: UUID!) {
        importRows(importId: $id, first: 100) { nodes { id } }
      }`,
      variables: { id: seeded.importId },
    });
    expect(supported.body?.errors).toBeUndefined();

    const selections = Array.from(
      { length: 5 },
      (_, index) =>
        `page${index}: importRows(importId: $id, first: 100) { nodes { id } }`,
    ).join("\n");
    const overBudget = await fixture.execute({
      jar: owner.jar,
      query: `query($id: UUID!) { ${selections} }`,
      variables: { id: seeded.importId },
    });
    expectGraphQLError(overBudget, "VALIDATION_FAILED");
    expect(overBudget.body?.errors?.[0]?.message).toBe(
      "Operation exceeds the allowed complexity.",
    );
  });
});
