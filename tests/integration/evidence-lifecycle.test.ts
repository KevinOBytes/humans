// @vitest-environment node

import { and, eq, isNull } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { evidenceExcerpts, evidenceItems, sources } from "@/db/schema/evidence";
import { auditEvents } from "@/db/schema/operations";
import { searchDocuments } from "@/db/schema/search";
import { createSearchIndexMaintenance } from "@/modules/search/indexer";
import {
  createTask12Metrics,
  disabledMetricsSink,
} from "@/modules/search/metrics";

import { expectGraphQLError, type OperationResult } from "../support/graphql";
import { ResearchFixture } from "../support/research-fixture";

const liveDescribe = process.env.TEST_DATABASE_URL ? describe : describe.skip;

function required<T>(value: T | null | undefined): T {
  if (value == null) throw new Error("Required fixture value is missing");
  return value;
}

const CREATE_SOURCE = /* GraphQL */ `
  mutation CreateSource($input: CreateSourceInput!) {
    createSource(input: $input) {
      source {
        id
        version
      }
    }
  }
`;
const CREATE_EVIDENCE = /* GraphQL */ `
  mutation CreateEvidence($input: CreateEvidenceItemInput!) {
    createEvidenceItem(input: $input) {
      evidenceItem {
        id
        version
      }
    }
  }
`;
const CREATE_EXCERPT = /* GraphQL */ `
  mutation CreateExcerpt($input: CreateEvidenceExcerptInput!) {
    createEvidenceExcerpt(input: $input) {
      evidenceExcerpt {
        id
      }
    }
  }
`;
const CREATE_NOTE = /* GraphQL */ `
  mutation CreateNote($input: CreateNoteInput!) {
    createNote(input: $input) {
      note {
        id
      }
    }
  }
`;
const ARCHIVE_SOURCE = /* GraphQL */ `
  mutation ArchiveSource($input: ArchiveSourceInput!) {
    archiveSource(input: $input) {
      code
      currentVersion
      source {
        id
        version
      }
    }
  }
`;
const ARCHIVE_EVIDENCE = /* GraphQL */ `
  mutation ArchiveEvidence($input: ArchiveEvidenceItemInput!) {
    archiveEvidenceItem(input: $input) {
      code
      currentVersion
      evidenceItem {
        id
        version
      }
    }
  }
`;
const UPDATE_SOURCE = /* GraphQL */ `
  mutation UpdateSource($input: UpdateSourceInput!) {
    updateSource(input: $input) {
      code
      source {
        id
        version
      }
    }
  }
`;
const UPDATE_EVIDENCE = /* GraphQL */ `
  mutation UpdateEvidence($input: UpdateEvidenceItemInput!) {
    updateEvidenceItem(input: $input) {
      code
      evidenceItem {
        id
        version
      }
    }
  }
`;

async function waitForEvidenceLockWaiters(
  fixture: ResearchFixture,
  minimum: number,
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const [{ blocked }] = await fixture.connection<[{ blocked: number }]>`
      SELECT count(*)::integer AS blocked
      FROM pg_stat_activity
      WHERE datname = current_database()
        AND pid <> pg_backend_pid()
        AND wait_event_type = 'Lock'
        AND query ILIKE '%evidence_items%FOR UPDATE%'
    `;
    if (blocked >= minimum) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Expected ${minimum} evidence row lock waiter(s)`);
}

liveDescribe("evidence lifecycle GraphQL acceptance", () => {
  let fixture: ResearchFixture;

  beforeAll(async () => {
    fixture = new ResearchFixture({
      searchIndexMaintenance: createSearchIndexMaintenance({
        metrics: createTask12Metrics(disabledMetricsSink),
      }),
    });
    await fixture.reset();
  });
  beforeEach(async () => fixture.reset());
  afterAll(async () => fixture.close());

  it("requires evidence archival before source archival and removes both from normal reads and search", async () => {
    const owner = await fixture.createActor();
    const foreignOwner = await fixture.createActor();
    const secret = "evidence lifecycle audit secret";
    const source = await fixture.execute<{
      createSource: { source: { id: string; version: number } | null };
    }>({
      jar: owner.jar,
      query: CREATE_SOURCE,
      variables: {
        input: { kind: "archive-test", title: "Lifecycle source" },
      },
    });
    const createdSource = required(source.body?.data?.createSource.source);
    const evidence = await fixture.execute<{
      createEvidenceItem: {
        evidenceItem: { id: string; version: number } | null;
      };
    }>({
      jar: owner.jar,
      query: CREATE_EVIDENCE,
      variables: {
        input: {
          sourceId: createdSource.id,
          extractedText: secret,
          checksum: `sha256:${"a".repeat(64)}`,
          reviewState: "ACCEPTED",
        },
      },
    });
    const createdEvidence = required(
      evidence.body?.data?.createEvidenceItem.evidenceItem,
    );

    expect(
      await fixture.database
        .select({ id: searchDocuments.id })
        .from(searchDocuments)
        .where(
          and(
            eq(searchDocuments.workspaceId, owner.workspaceId),
            eq(searchDocuments.resourceKind, "evidence_item"),
            eq(searchDocuments.resourceId, createdEvidence.id),
          ),
        ),
    ).toHaveLength(1);
    const excerpt = await fixture.execute<{
      createEvidenceExcerpt: { evidenceExcerpt: { id: string } | null };
    }>({
      jar: owner.jar,
      query: CREATE_EXCERPT,
      variables: {
        input: {
          evidenceItemId: createdEvidence.id,
          excerpt: "Derived search excerpt",
          checksum: `sha256:${"c".repeat(64)}`,
        },
      },
    });
    const excerptId = required(
      excerpt.body?.data?.createEvidenceExcerpt.evidenceExcerpt?.id,
    );
    const note = await fixture.execute<{
      createNote: { note: { id: string } | null };
    }>({
      jar: owner.jar,
      query: CREATE_NOTE,
      variables: {
        input: {
          subject: { evidenceItemId: createdEvidence.id },
          content: { plainText: "Derived search note" },
        },
      },
    });
    const noteId = required(note.body?.data?.createNote.note?.id);
    expect(
      await fixture.database
        .select({ resourceId: searchDocuments.resourceId })
        .from(searchDocuments)
        .where(
          and(
            eq(searchDocuments.workspaceId, owner.workspaceId),
            eq(searchDocuments.resultId, createdEvidence.id),
          ),
        ),
    ).toEqual(
      expect.arrayContaining([
        { resourceId: createdEvidence.id },
        { resourceId: excerptId },
        { resourceId: noteId },
      ]),
    );

    const foreignArchive = await fixture.execute({
      jar: foreignOwner.jar,
      query: ARCHIVE_EVIDENCE,
      variables: {
        input: {
          id: createdEvidence.id,
          expectedVersion: createdEvidence.version,
        },
      },
    });
    expectGraphQLError(foreignArchive, "NOT_FOUND");

    const sourcePrecondition = await fixture.execute({
      jar: owner.jar,
      query: ARCHIVE_SOURCE,
      variables: {
        input: { id: createdSource.id, expectedVersion: createdSource.version },
      },
    });
    expectGraphQLError(sourcePrecondition, "PRECONDITION_FAILED");

    const updatedEvidence = await fixture.execute<{
      updateEvidenceItem: {
        code: string | null;
        evidenceItem: { id: string; version: number } | null;
      };
    }>({
      jar: owner.jar,
      query: UPDATE_EVIDENCE,
      variables: {
        input: {
          id: createdEvidence.id,
          expectedVersion: createdEvidence.version,
          externalLocator: "https://example.test/lifecycle-updated",
        },
      },
    });
    expect(updatedEvidence.body?.data?.updateEvidenceItem).toEqual({
      code: null,
      evidenceItem: { id: createdEvidence.id, version: 2 },
    });
    const staleEvidenceArchive = await fixture.execute<{
      archiveEvidenceItem: {
        code: string | null;
        currentVersion: number | null;
        evidenceItem: null;
      };
    }>({
      jar: owner.jar,
      query: ARCHIVE_EVIDENCE,
      variables: {
        input: {
          id: createdEvidence.id,
          expectedVersion: createdEvidence.version,
        },
      },
    });
    expect(staleEvidenceArchive.body?.data?.archiveEvidenceItem).toEqual({
      code: "CONFLICT",
      currentVersion: 2,
      evidenceItem: null,
    });

    const archivedEvidence = await fixture.execute<{
      archiveEvidenceItem: {
        code: string | null;
        evidenceItem: { id: string; version: number } | null;
      };
    }>({
      jar: owner.jar,
      query: ARCHIVE_EVIDENCE,
      variables: {
        input: {
          id: createdEvidence.id,
          expectedVersion: 2,
        },
      },
    });
    expect(archivedEvidence.body?.data?.archiveEvidenceItem).toEqual({
      code: null,
      currentVersion: null,
      evidenceItem: { id: createdEvidence.id, version: 3 },
    });

    expect(
      await fixture.database
        .select({ id: searchDocuments.id })
        .from(searchDocuments)
        .where(
          and(
            eq(searchDocuments.workspaceId, owner.workspaceId),
            eq(searchDocuments.resultId, createdEvidence.id),
          ),
        ),
    ).toEqual([]);

    const updatedSource = await fixture.execute<{
      updateSource: {
        code: string | null;
        source: { id: string; version: number } | null;
      };
    }>({
      jar: owner.jar,
      query: UPDATE_SOURCE,
      variables: {
        input: {
          id: createdSource.id,
          expectedVersion: createdSource.version,
          title: "Lifecycle source updated",
        },
      },
    });
    expect(updatedSource.body?.data?.updateSource).toEqual({
      code: null,
      source: { id: createdSource.id, version: 2 },
    });
    const staleSourceArchive = await fixture.execute<{
      archiveSource: {
        code: string | null;
        currentVersion: number | null;
        source: null;
      };
    }>({
      jar: owner.jar,
      query: ARCHIVE_SOURCE,
      variables: {
        input: {
          id: createdSource.id,
          expectedVersion: createdSource.version,
        },
      },
    });
    expect(staleSourceArchive.body?.data?.archiveSource).toEqual({
      code: "CONFLICT",
      currentVersion: 2,
      source: null,
    });

    const archivedSource = await fixture.execute<{
      archiveSource: {
        code: string | null;
        source: { id: string; version: number } | null;
      };
    }>({
      jar: owner.jar,
      query: ARCHIVE_SOURCE,
      variables: {
        input: { id: createdSource.id, expectedVersion: 2 },
      },
    });
    expect(archivedSource.body?.data?.archiveSource).toEqual({
      code: null,
      currentVersion: null,
      source: { id: createdSource.id, version: 3 },
    });

    const visibility = await fixture.execute<{
      evidenceItem: { id: string } | null;
      evidenceItems: { nodes: Array<{ id: string }> };
      source: { id: string } | null;
      sources: { nodes: Array<{ id: string }> };
    }>({
      jar: owner.jar,
      query: /* GraphQL */ `
        query Visibility($sourceId: UUID!, $evidenceId: UUID!) {
          source(id: $sourceId) {
            id
          }
          sources(first: 10) {
            nodes {
              id
            }
          }
          evidenceItem(id: $evidenceId) {
            id
          }
          evidenceItems(first: 10) {
            nodes {
              id
            }
          }
        }
      `,
      variables: { sourceId: createdSource.id, evidenceId: createdEvidence.id },
    });
    expect(visibility.body?.errors).toBeUndefined();
    expect(visibility.body?.data).toEqual({
      source: null,
      sources: { nodes: [] },
      evidenceItem: null,
      evidenceItems: { nodes: [] },
    });

    const [storedSource] = await fixture.database
      .select({
        deletedAt: sources.deletedAt,
        deletedBy: sources.deletedBy,
        version: sources.version,
      })
      .from(sources)
      .where(
        and(
          eq(sources.workspaceId, owner.workspaceId),
          eq(sources.id, createdSource.id),
        ),
      );
    const [storedEvidence] = await fixture.database
      .select({
        deletedAt: evidenceItems.deletedAt,
        deletedBy: evidenceItems.deletedBy,
        version: evidenceItems.version,
      })
      .from(evidenceItems)
      .where(
        and(
          eq(evidenceItems.workspaceId, owner.workspaceId),
          eq(evidenceItems.id, createdEvidence.id),
        ),
      );
    expect(storedSource).toMatchObject({
      deletedBy: owner.principalId,
      version: 3,
    });
    expect(storedSource?.deletedAt).toBeInstanceOf(Date);
    expect(storedEvidence).toMatchObject({
      deletedBy: owner.principalId,
      version: 3,
    });
    expect(storedEvidence?.deletedAt).toBeInstanceOf(Date);

    expect(
      await fixture.database
        .select({ id: searchDocuments.id })
        .from(searchDocuments)
        .where(
          and(
            eq(searchDocuments.workspaceId, owner.workspaceId),
            eq(searchDocuments.resourceKind, "source"),
            eq(searchDocuments.resourceId, createdSource.id),
          ),
        ),
    ).toEqual([]);
    const archiveAudits = await fixture.database
      .select({
        action: auditEvents.action,
        redactedDiff: auditEvents.redactedDiff,
      })
      .from(auditEvents)
      .where(eq(auditEvents.workspaceId, owner.workspaceId));
    expect(archiveAudits.map((row) => row.action)).toEqual(
      expect.arrayContaining(["evidence.archive", "source.archive"]),
    );
    expect(JSON.stringify(archiveAudits)).not.toContain(secret);
  });

  it("serializes source archival against evidence creation", async () => {
    const owner = await fixture.createActor();
    const source = await fixture.execute<{
      createSource: { source: { id: string; version: number } | null };
    }>({
      jar: owner.jar,
      query: CREATE_SOURCE,
      variables: { input: { kind: "race-test", title: "Race source" } },
    });
    const createdSource = required(source.body?.data?.createSource.source);

    const [archive, create] = await Promise.all([
      fixture.execute({
        jar: owner.jar,
        query: ARCHIVE_SOURCE,
        variables: {
          input: {
            id: createdSource.id,
            expectedVersion: createdSource.version,
          },
        },
      }),
      fixture.execute<{
        createEvidenceItem: { evidenceItem: { id: string } | null };
      }>({
        jar: owner.jar,
        query: CREATE_EVIDENCE,
        variables: {
          input: {
            sourceId: createdSource.id,
            checksum: `sha256:${"b".repeat(64)}`,
          },
        },
      }),
    ]);
    const [storedSource] = await fixture.database
      .select({ deletedAt: sources.deletedAt })
      .from(sources)
      .where(
        and(
          eq(sources.workspaceId, owner.workspaceId),
          eq(sources.id, createdSource.id),
        ),
      );
    const activeEvidence = await fixture.database
      .select({ id: evidenceItems.id })
      .from(evidenceItems)
      .where(
        and(
          eq(evidenceItems.workspaceId, owner.workspaceId),
          eq(evidenceItems.sourceId, createdSource.id),
          isNull(evidenceItems.deletedAt),
        ),
      );

    expect(Boolean(storedSource?.deletedAt && activeEvidence.length > 0)).toBe(
      false,
    );
    if (storedSource?.deletedAt) {
      expectGraphQLError(create, "NOT_FOUND");
    } else {
      expectGraphQLError(archive, "PRECONDITION_FAILED");
      expect(create.body?.data?.createEvidenceItem.evidenceItem?.id).toEqual(
        expect.any(String),
      );
    }
  });

  it("reports the fresh locked evidence version after an archive race", async () => {
    const owner = await fixture.createActor();
    const source = await fixture.execute<{
      createSource: { source: { id: string } | null };
    }>({
      jar: owner.jar,
      query: CREATE_SOURCE,
      variables: { input: { kind: "race-test", title: "Version race" } },
    });
    const sourceId = required(source.body?.data?.createSource.source?.id);
    const evidence = await fixture.execute<{
      createEvidenceItem: {
        evidenceItem: { id: string; version: number } | null;
      };
    }>({
      jar: owner.jar,
      query: CREATE_EVIDENCE,
      variables: {
        input: {
          sourceId,
          checksum: `sha256:${"d".repeat(64)}`,
        },
      },
    });
    const createdEvidence = required(
      evidence.body?.data?.createEvidenceItem.evidenceItem,
    );
    let pendingArchive: ReturnType<ResearchFixture["execute"]> | undefined;

    await fixture.connection.begin(async (locker) => {
      await locker`
        SELECT id FROM evidence_items
        WHERE id = ${createdEvidence.id}::uuid
        FOR UPDATE
      `;
      pendingArchive = fixture.execute({
        jar: owner.jar,
        query: ARCHIVE_EVIDENCE,
        variables: {
          input: {
            id: createdEvidence.id,
            expectedVersion: createdEvidence.version,
          },
        },
      });
      await waitForEvidenceLockWaiters(fixture, 1);
      await locker`
        UPDATE evidence_items
        SET version = version + 1, updated_at = now()
        WHERE id = ${createdEvidence.id}::uuid
      `;
    });

    const result = await required(pendingArchive);
    expect(result.body?.data).toEqual({
      archiveEvidenceItem: {
        code: "CONFLICT",
        currentVersion: 2,
        evidenceItem: null,
      },
    });
  });

  it("queues dependent evidence writes behind archive revalidation", async () => {
    const owner = await fixture.createActor();
    const source = await fixture.execute<{
      createSource: { source: { id: string } | null };
    }>({
      jar: owner.jar,
      query: CREATE_SOURCE,
      variables: { input: { kind: "race-test", title: "Dependent race" } },
    });
    const sourceId = required(source.body?.data?.createSource.source?.id);
    const evidence = await fixture.execute<{
      createEvidenceItem: {
        evidenceItem: { id: string; version: number } | null;
      };
    }>({
      jar: owner.jar,
      query: CREATE_EVIDENCE,
      variables: {
        input: {
          sourceId,
          checksum: `sha256:${"e".repeat(64)}`,
        },
      },
    });
    const createdEvidence = required(
      evidence.body?.data?.createEvidenceItem.evidenceItem,
    );
    let pendingArchive: Promise<OperationResult> | undefined;
    let pendingExcerpt: Promise<OperationResult> | undefined;

    await fixture.connection.begin(async (locker) => {
      await locker`
        SELECT id FROM evidence_items
        WHERE id = ${createdEvidence.id}::uuid
        FOR UPDATE
      `;
      pendingArchive = fixture.execute({
        jar: owner.jar,
        query: ARCHIVE_EVIDENCE,
        variables: {
          input: {
            id: createdEvidence.id,
            expectedVersion: createdEvidence.version,
          },
        },
      });
      await waitForEvidenceLockWaiters(fixture, 1);
      pendingExcerpt = fixture.execute({
        jar: owner.jar,
        query: CREATE_EXCERPT,
        variables: {
          input: {
            evidenceItemId: createdEvidence.id,
            excerpt: "Must not commit after archive",
            checksum: `sha256:${"f".repeat(64)}`,
          },
        },
      });
      await waitForEvidenceLockWaiters(fixture, 2);
    });

    const archiveResult = await required(pendingArchive);
    const excerptResult = await required(pendingExcerpt);
    expect(archiveResult.body?.data).toEqual({
      archiveEvidenceItem: {
        code: null,
        currentVersion: null,
        evidenceItem: { id: createdEvidence.id, version: 2 },
      },
    });
    expectGraphQLError(excerptResult, "NOT_FOUND");
    expect(
      await fixture.database
        .select({ id: evidenceExcerpts.id })
        .from(evidenceExcerpts)
        .where(eq(evidenceExcerpts.evidenceItemId, createdEvidence.id)),
    ).toEqual([]);
  });
});
