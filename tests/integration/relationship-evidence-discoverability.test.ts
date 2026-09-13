// @vitest-environment node

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { newId } from "@/db/id";
import {
  evidenceItems,
  relationshipEvidence,
  sources,
} from "@/db/schema/evidence";
import { relationships, relationshipTypes } from "@/db/schema/relationships";

import { ResearchFixture } from "../support/research-fixture";

const liveDescribe = process.env.TEST_DATABASE_URL ? describe : describe.skip;

function required<T>(value: T | null | undefined): T {
  if (value == null) throw new Error("Required fixture value is missing");
  return value;
}

liveDescribe("relationship evidence discoverability", () => {
  let fixture: ResearchFixture;

  beforeAll(() => {
    fixture = new ResearchFixture();
  });
  beforeEach(async () => fixture.reset());
  afterAll(async () => fixture.close());

  it("paginates visible evidence while redacting inaccessible evidence and sources", async () => {
    const owner = await fixture.createActor();
    const viewer = await fixture.createWorkspaceMember(owner, "viewer");
    const sourcePerson = required(
      (await fixture.createPerson(owner, { displayName: "Source person" })).body
        ?.data?.createPerson?.person,
    );
    const targetPerson = required(
      (await fixture.createPerson(owner, { displayName: "Target person" })).body
        ?.data?.createPerson?.person,
    );
    const relationshipTypeId = newId();
    const relationshipId = newId();
    const visibleSourceId = newId();
    const redactedSourceId = newId();
    const hiddenEvidenceSourceId = newId();
    const visibleEvidenceId = newId();
    const redactedSourceEvidenceId = newId();
    const hiddenEvidenceId = newId();
    const principalId = owner.principalId;

    await fixture.database.insert(relationshipTypes).values({
      id: relationshipTypeId,
      workspaceId: owner.workspaceId,
      key: "documented_peer",
      forwardLabel: "documented peer",
      inverseLabel: "documented peer",
      createdBy: principalId,
      updatedBy: principalId,
    });
    await fixture.database.insert(relationships).values({
      id: relationshipId,
      workspaceId: owner.workspaceId,
      sourcePersonId: sourcePerson.id,
      targetPersonId: targetPerson.id,
      relationshipTypeId,
      state: "asserted",
      reviewState: "approved",
      createdBy: principalId,
      updatedBy: principalId,
    });
    await fixture.database.insert(sources).values([
      {
        id: visibleSourceId,
        workspaceId: owner.workspaceId,
        kind: "interview",
        title: "Published interview",
        citation: "Interview transcript, 2024",
        sensitivity: "internal",
        createdBy: principalId,
        updatedBy: principalId,
      },
      {
        id: redactedSourceId,
        workspaceId: owner.workspaceId,
        kind: "restricted-document",
        title: "Confidential source title must not render",
        citation: "Confidential citation must not render",
        sensitivity: "confidential",
        createdBy: principalId,
        updatedBy: principalId,
      },
      {
        id: hiddenEvidenceSourceId,
        workspaceId: owner.workspaceId,
        kind: "document",
        title: "Source for hidden evidence",
        sensitivity: "internal",
        createdBy: principalId,
        updatedBy: principalId,
      },
    ]);
    await fixture.database.insert(evidenceItems).values([
      {
        id: visibleEvidenceId,
        workspaceId: owner.workspaceId,
        sourceId: visibleSourceId,
        checksum: `sha256:${"a".repeat(64)}`,
        reviewState: "accepted",
        sensitivity: "internal",
        createdBy: principalId,
        updatedBy: principalId,
      },
      {
        id: redactedSourceEvidenceId,
        workspaceId: owner.workspaceId,
        sourceId: redactedSourceId,
        checksum: `sha256:${"b".repeat(64)}`,
        reviewState: "pending",
        sensitivity: "internal",
        createdBy: principalId,
        updatedBy: principalId,
      },
      {
        id: hiddenEvidenceId,
        workspaceId: owner.workspaceId,
        sourceId: hiddenEvidenceSourceId,
        checksum: `sha256:${"c".repeat(64)}`,
        reviewState: "accepted",
        sensitivity: "confidential",
        createdBy: principalId,
        updatedBy: principalId,
      },
    ]);
    await fixture.database.insert(relationshipEvidence).values([
      {
        id: newId(),
        workspaceId: owner.workspaceId,
        relationshipId,
        evidenceItemId: visibleEvidenceId,
        locator: "page 14",
        createdAt: new Date("2026-03-03T00:00:00.000Z"),
        createdBy: principalId,
      },
      {
        id: newId(),
        workspaceId: owner.workspaceId,
        relationshipId,
        evidenceItemId: redactedSourceEvidenceId,
        locator: "section 2",
        createdAt: new Date("2026-03-02T00:00:00.000Z"),
        createdBy: principalId,
      },
      {
        id: newId(),
        workspaceId: owner.workspaceId,
        relationshipId,
        evidenceItemId: hiddenEvidenceId,
        locator: "hidden locator",
        createdAt: new Date("2026-03-01T00:00:00.000Z"),
        createdBy: principalId,
      },
    ]);

    const query = /* GraphQL */ `
      query RelationshipEvidence($id: UUID!, $after: String) {
        relationship(id: $id) {
          reviewState
          evidence(first: 1, after: $after) {
            nodes {
              evidenceItemId
              locator
              evidenceItem {
                id
                reviewState
                source {
                  id
                  title
                  citation
                }
              }
            }
            pageInfo {
              endCursor
              hasNextPage
            }
          }
        }
      }
    `;
    const firstPage = await fixture.execute<{
      relationship: {
        reviewState: string;
        evidence: {
          nodes: Array<{
            evidenceItemId: string;
            locator: string | null;
            evidenceItem: {
              id: string;
              reviewState: string;
              source: {
                id: string;
                title: string;
                citation: string | null;
              } | null;
            } | null;
          }>;
          pageInfo: { endCursor: string | null; hasNextPage: boolean };
        } | null;
      } | null;
    }>({ jar: viewer.jar, query, variables: { id: relationshipId } });

    expect(firstPage.body?.errors).toBeUndefined();
    expect(firstPage.body?.data?.relationship).toEqual({
      reviewState: "approved",
      evidence: {
        nodes: [
          {
            evidenceItemId: visibleEvidenceId,
            locator: "page 14",
            evidenceItem: {
              id: visibleEvidenceId,
              reviewState: "accepted",
              source: {
                id: visibleSourceId,
                title: "Published interview",
                citation: "Interview transcript, 2024",
              },
            },
          },
        ],
        pageInfo: {
          endCursor: expect.any(String),
          hasNextPage: true,
        },
      },
    });

    const secondPage = await fixture.execute<{
      relationship: {
        reviewState: string;
        evidence: {
          nodes: Array<{
            evidenceItemId: string;
            locator: string | null;
            evidenceItem: {
              id: string;
              reviewState: string;
              source: {
                id: string;
                title: string;
                citation: string | null;
              } | null;
            } | null;
          }>;
          pageInfo: { endCursor: string | null; hasNextPage: boolean };
        } | null;
      } | null;
    }>({
      jar: viewer.jar,
      query,
      variables: {
        id: relationshipId,
        after: firstPage.body?.data?.relationship?.evidence?.pageInfo.endCursor,
      },
    });

    expect(secondPage.body?.errors).toBeUndefined();
    expect(secondPage.body?.data?.relationship).toEqual({
      reviewState: "approved",
      evidence: {
        nodes: [
          {
            evidenceItemId: redactedSourceEvidenceId,
            locator: "section 2",
            evidenceItem: {
              id: redactedSourceEvidenceId,
              reviewState: "pending",
              source: null,
            },
          },
        ],
        pageInfo: {
          endCursor: expect.any(String),
          hasNextPage: false,
        },
      },
    });
    expect(JSON.stringify(secondPage.body)).not.toContain(
      "Confidential source title must not render",
    );
    expect(JSON.stringify(secondPage.body)).not.toContain(
      "Confidential citation must not render",
    );
    expect(JSON.stringify(secondPage.body)).not.toContain(hiddenEvidenceId);
    expect(JSON.stringify(secondPage.body)).not.toContain("hidden locator");
  });
});
