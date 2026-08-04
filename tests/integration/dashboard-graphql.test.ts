// @vitest-environment node

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import { newId } from "@/db/id";
import { analysisRuns, graphSnapshots } from "@/db/schema/graph";
import { people } from "@/db/schema/people";
import { relationshipTypes, relationships } from "@/db/schema/relationships";
import {
  accessPolicies,
  resourceGrants,
  workspaceSettings,
} from "@/db/schema/workspaces";

import { expectGraphQLError } from "../support/graphql";
import { ResearchFixture } from "../support/research-fixture";

const liveDescribe = process.env.TEST_DATABASE_URL ? describe : describe.skip;

function snapshotContract(actorPrincipalId: string) {
  return {
    manifestSchema: "humans.graph-snapshot-manifest.v1",
    manifestHash: "11".repeat(32),
    manifestMaterial: { fixture: "authorization-only" },
    queryHash: "22".repeat(32),
    authorizationHash: "33".repeat(32),
    actorPrincipalId,
    actorKind: "USER",
    includedRelationshipTypeVersions: {},
    algorithm: "DEGREE",
    algorithmVersion: "graphology@0.26.0/degree/humans-v1",
    algorithmConfigHash: "44".repeat(32),
    algorithmConfiguration: {
      projection: "authorized-visible-incidence-v1",
    },
    runtimeContract: {
      graphFingerprintVersion: "humans.graph-fingerprint.v1",
      manifestVersion: "humans.graph-snapshot-manifest.v1",
      nodeMajor: 24,
      packages: {
        graphology: "0.26.0",
        graphologyCommunitiesLouvain: "2.0.2",
        graphologyMetrics: "2.4.0",
      },
      postgresMajor: 18,
      serviceVersion: "0.1.0",
    },
  } as const;
}

function analysisContract(actorPrincipalId: string) {
  return {
    actorPrincipalId,
    actorKind: "USER",
    algorithmVersion: "graphology@0.26.0/degree/humans-v1",
    configurationHash: "44".repeat(32),
    configuration: { projection: "authorized-visible-incidence-v1" },
    state: "completed",
    startedAt: new Date("2026-08-04T12:00:00.000Z"),
    completedAt: new Date("2026-08-04T12:00:00.000Z"),
  } as const;
}

const DASHBOARD_QUERY = /* GraphQL */ `
  query Dashboard($peopleFirst: Int, $analysisFirst: Int) {
    dashboardRecentPeople(first: $peopleFirst) {
      nodes {
        id
        displayName
        updatedAt
      }
      pageInfo {
        endCursor
        hasNextPage
      }
    }
    dashboardRecentGraphAnalyses(first: $analysisFirst) {
      nodes {
        id
        algorithm
        createdAt
      }
      pageInfo {
        endCursor
        hasNextPage
      }
    }
    graphStatistics {
      visiblePeople
      visibleRelationships
    }
    workspacePolicySummary {
      defaultRetentionDays
      aiEnabled
      storageEnabled
    }
  }
`;

liveDescribe("dashboard GraphQL summaries", () => {
  let fixture: ResearchFixture;

  beforeAll(() => {
    fixture = new ResearchFixture();
  });
  beforeEach(async () => fixture.reset());
  afterAll(async () => fixture.close());

  it("returns deterministic recent research and exact visibility-aware summaries", async () => {
    const owner = await fixture.createActor();
    const viewer = await fixture.createWorkspaceMember(owner, "viewer");
    const foreign = await fixture.createActor();
    const tied = new Date("2026-08-04T12:00:00.000Z");
    const older = new Date("2026-08-03T12:00:00.000Z");
    const ids = {
      visibleLow: "018f0000-0000-7000-8000-000000009001",
      visibleHigh: "018f0000-0000-7000-8000-000000009002",
      hidden: "018f0000-0000-7000-8000-000000009003",
      deleted: "018f0000-0000-7000-8000-000000009004",
      foreign: "018f0000-0000-7000-8000-000000009005",
      type: "018f0000-0000-7000-8000-000000009101",
      visibleEdge: "018f0000-0000-7000-8000-000000009201",
      grantedEdge: "018f0000-0000-7000-8000-000000009202",
      hiddenEndpointEdge: "018f0000-0000-7000-8000-000000009203",
    } as const;

    await fixture.database.insert(people).values([
      {
        id: ids.visibleLow,
        workspaceId: owner.workspaceId,
        displayName: "Visible low ID",
        sensitivity: "internal",
        createdAt: older,
        updatedAt: tied,
        createdBy: owner.principalId,
        updatedBy: owner.principalId,
      },
      {
        id: ids.visibleHigh,
        workspaceId: owner.workspaceId,
        displayName: "Visible high ID",
        sensitivity: "internal",
        createdAt: older,
        updatedAt: tied,
        createdBy: owner.principalId,
        updatedBy: owner.principalId,
      },
      {
        id: ids.hidden,
        workspaceId: owner.workspaceId,
        displayName: "Hidden endpoint",
        sensitivity: "confidential",
        createdAt: older,
        updatedAt: new Date("2026-08-05T12:00:00.000Z"),
        createdBy: owner.principalId,
        updatedBy: owner.principalId,
      },
      {
        id: ids.deleted,
        workspaceId: owner.workspaceId,
        displayName: "Deleted person",
        sensitivity: "internal",
        deletedAt: new Date("2026-08-04T13:00:00.000Z"),
        createdAt: older,
        updatedAt: new Date("2026-08-06T12:00:00.000Z"),
        createdBy: owner.principalId,
        updatedBy: owner.principalId,
        deletedBy: owner.principalId,
      },
      {
        id: ids.foreign,
        workspaceId: foreign.workspaceId,
        displayName: "Foreign person",
        sensitivity: "internal",
        createdAt: older,
        updatedAt: new Date("2026-08-07T12:00:00.000Z"),
        createdBy: foreign.principalId,
        updatedBy: foreign.principalId,
      },
    ]);
    await fixture.database.insert(relationshipTypes).values({
      id: ids.type,
      workspaceId: owner.workspaceId,
      key: "dashboard-knows",
      forwardLabel: "knows",
      inverseLabel: "known by",
      createdBy: owner.principalId,
      updatedBy: owner.principalId,
    });
    await fixture.database.insert(relationships).values([
      {
        id: ids.visibleEdge,
        workspaceId: owner.workspaceId,
        sourcePersonId: ids.visibleLow,
        targetPersonId: ids.visibleHigh,
        relationshipTypeId: ids.type,
        sensitivity: "internal",
        createdBy: owner.principalId,
        updatedBy: owner.principalId,
      },
      {
        id: ids.grantedEdge,
        workspaceId: owner.workspaceId,
        sourcePersonId: ids.visibleLow,
        targetPersonId: ids.visibleHigh,
        relationshipTypeId: ids.type,
        sensitivity: "confidential",
        createdBy: owner.principalId,
        updatedBy: owner.principalId,
      },
      {
        id: ids.hiddenEndpointEdge,
        workspaceId: owner.workspaceId,
        sourcePersonId: ids.visibleLow,
        targetPersonId: ids.hidden,
        relationshipTypeId: ids.type,
        sensitivity: "internal",
        createdBy: owner.principalId,
        updatedBy: owner.principalId,
      },
    ]);
    const policyId = newId();
    await fixture.database.insert(accessPolicies).values({
      id: policyId,
      workspaceId: owner.workspaceId,
      name: "Viewer dashboard relationship",
      sensitivityCeiling: "confidential",
      resourceKinds: ["relationship"],
      roleBindings: {},
      state: "active",
      createdBy: owner.principalId,
      updatedBy: owner.principalId,
    });
    await fixture.database.insert(resourceGrants).values({
      id: newId(),
      workspaceId: owner.workspaceId,
      policyId,
      role: "viewer",
      resourceId: ids.grantedEdge,
      resourceKind: "relationship",
      createdBy: owner.principalId,
      updatedBy: owner.principalId,
    });
    await fixture.database
      .update(workspaceSettings)
      .set({ retentionDays: 90, aiEnabled: true, storageEnabled: false })
      .where(eq(workspaceSettings.workspaceId, owner.workspaceId));

    const snapshotIds = [
      "018f0000-0000-7000-8000-000000009301",
      "018f0000-0000-7000-8000-000000009302",
    ] as const;
    const runIds = [
      "018f0000-0000-7000-8000-000000009401",
      "018f0000-0000-7000-8000-000000009402",
    ] as const;
    await fixture.database.insert(graphSnapshots).values(
      snapshotIds.map((id) => ({
        id,
        workspaceId: owner.workspaceId,
        ...snapshotContract(viewer.principalId),
        graphViewId: null,
        queryInput: {
          mode: "WORKSPACE",
          rootPersonIds: [],
          sensitivities: [],
        },
        includedPersonVersions: {},
        includedRelationshipVersions: {},
        createdBy: viewer.principalId,
      })),
    );
    await fixture.database.insert(analysisRuns).values(
      runIds.map((id, index) => ({
        id,
        workspaceId: owner.workspaceId,
        ...analysisContract(viewer.principalId),
        algorithm: "DEGREE",
        graphSnapshotId: snapshotIds[index]!,
        createdAt: tied,
        createdBy: viewer.principalId,
      })),
    );

    const result = await fixture.execute<{
      dashboardRecentPeople: {
        nodes: Array<{ id: string; displayName: string; updatedAt: string }>;
      };
      dashboardRecentGraphAnalyses: {
        nodes: Array<{ id: string; algorithm: string; createdAt: string }>;
      };
      graphStatistics: {
        visiblePeople: number;
        visibleRelationships: number;
      };
      workspacePolicySummary: {
        defaultRetentionDays: number | null;
        aiEnabled: boolean;
        storageEnabled: boolean;
      };
    }>({
      jar: viewer.jar,
      query: DASHBOARD_QUERY,
      variables: { peopleFirst: 10, analysisFirst: 10 },
    });

    expect(result.body?.errors).toBeUndefined();
    expect(
      result.body?.data?.dashboardRecentPeople.nodes.map(({ id }) => id),
    ).toEqual([ids.visibleHigh, ids.visibleLow]);
    expect(
      result.body?.data?.dashboardRecentGraphAnalyses.nodes.map(({ id }) => id),
    ).toEqual([...runIds].sort().reverse());
    expect(result.body?.data?.graphStatistics).toEqual({
      visiblePeople: 2,
      visibleRelationships: 2,
    });
    expect(result.body?.data?.workspacePolicySummary).toEqual({
      defaultRetentionDays: 90,
      aiEnabled: true,
      storageEnabled: false,
    });
    expect(JSON.stringify(result.body)).not.toContain("Foreign person");
    expect(JSON.stringify(result.body)).not.toContain("Hidden endpoint");

    const recentPeoplePage = await fixture.execute<{
      dashboardRecentPeople: {
        nodes: Array<{ id: string }>;
        pageInfo: { endCursor: string; hasNextPage: boolean };
      };
    }>({
      jar: viewer.jar,
      query: `query { dashboardRecentPeople(first: 1) { nodes { id } pageInfo { endCursor hasNextPage } } }`,
    });
    const nextPeoplePage = await fixture.execute<{
      dashboardRecentPeople: { nodes: Array<{ id: string }> };
    }>({
      jar: viewer.jar,
      query: `query($after: String) { dashboardRecentPeople(first: 1, after: $after) { nodes { id } } }`,
      variables: {
        after:
          recentPeoplePage.body?.data?.dashboardRecentPeople.pageInfo.endCursor,
      },
    });
    expect(nextPeoplePage.body?.errors).toBeUndefined();
    expect(recentPeoplePage.body?.data?.dashboardRecentPeople).toEqual({
      nodes: [{ id: ids.visibleHigh }],
      pageInfo: { endCursor: expect.any(String), hasNextPage: true },
    });
    expect(nextPeoplePage.body?.data?.dashboardRecentPeople.nodes).toEqual([
      { id: ids.visibleLow },
    ]);

    const recentAnalysesPage = await fixture.execute<{
      dashboardRecentGraphAnalyses: {
        nodes: Array<{ id: string }>;
        pageInfo: { endCursor: string; hasNextPage: boolean };
      };
    }>({
      jar: viewer.jar,
      query: `query { dashboardRecentGraphAnalyses(first: 1) { nodes { id } pageInfo { endCursor hasNextPage } } }`,
    });
    const nextAnalysesPage = await fixture.execute<{
      dashboardRecentGraphAnalyses: { nodes: Array<{ id: string }> };
    }>({
      jar: viewer.jar,
      query: `query($after: String) { dashboardRecentGraphAnalyses(first: 1, after: $after) { nodes { id } } }`,
      variables: {
        after:
          recentAnalysesPage.body?.data?.dashboardRecentGraphAnalyses.pageInfo
            .endCursor,
      },
    });
    expect(nextAnalysesPage.body?.errors).toBeUndefined();
    expect(recentAnalysesPage.body?.data?.dashboardRecentGraphAnalyses).toEqual(
      {
        nodes: [{ id: runIds[1] }],
        pageInfo: { endCursor: expect.any(String), hasNextPage: true },
      },
    );
    expect(
      nextAnalysesPage.body?.data?.dashboardRecentGraphAnalyses.nodes,
    ).toEqual([{ id: runIds[0] }]);

    for (const variables of [
      { peopleFirst: 0, analysisFirst: 1 },
      { peopleFirst: -1, analysisFirst: 1 },
      { peopleFirst: 11, analysisFirst: 1 },
      { peopleFirst: 1, analysisFirst: 0 },
      { peopleFirst: 1, analysisFirst: -1 },
      { peopleFirst: 1, analysisFirst: 11 },
    ]) {
      const invalid = await fixture.execute({
        jar: viewer.jar,
        query: DASHBOARD_QUERY,
        variables,
      });
      expectGraphQLError(invalid, "VALIDATION_FAILED");
      expect(invalid.body?.errors?.[0]?.message).toBe(
        "first must be between 1 and 10.",
      );
    }
  });

  it("exposes only the safe three-field policy summary to owners and viewers", async () => {
    const owner = await fixture.createActor();
    const viewer = await fixture.createWorkspaceMember(owner, "viewer");
    for (const jar of [owner.jar, viewer.jar]) {
      const result = await fixture.execute<{
        workspacePolicySummary: Record<string, unknown>;
      }>({
        jar,
        query: `query { workspacePolicySummary { defaultRetentionDays aiEnabled storageEnabled } }`,
      });
      expect(result.body?.errors).toBeUndefined();
      expect(
        Object.keys(result.body?.data?.workspacePolicySummary ?? {}),
      ).toEqual(["defaultRetentionDays", "aiEnabled", "storageEnabled"]);
    }
  });
});
