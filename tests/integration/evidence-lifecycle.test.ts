// @vitest-environment node

import { and, eq, isNull } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { evidenceItems, sources } from "@/db/schema/evidence";
import { auditEvents } from "@/db/schema/operations";
import { searchDocuments } from "@/db/schema/search";
import { createSearchIndexMaintenance } from "@/modules/search/indexer";
import {
  createTask12Metrics,
  disabledMetricsSink,
} from "@/modules/search/metrics";

import { expectGraphQLError } from "../support/graphql";
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
          reviewState: "IN_REVIEW",
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
            eq(searchDocuments.resourceKind, "evidence_item"),
            eq(searchDocuments.resourceId, createdEvidence.id),
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
});
