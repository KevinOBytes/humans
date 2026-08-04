// @vitest-environment node

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import { newId } from "@/db/id";
import { aiMessages, aiRuns, aiThreads, aiToolCalls } from "@/db/schema/ai";
import { analysisRuns, graphSnapshots, graphViews } from "@/db/schema/graph";
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

  it("reauthorizes non-empty recent analysis manifests and excludes private and foreign runs", async () => {
    const owner = await fixture.createActor();
    const viewer = await fixture.createWorkspaceMember(owner, "viewer");
    const foreign = await fixture.createActor();
    const ids = {
      source: "018f0000-0000-7000-8000-000000008001",
      target: "018f0000-0000-7000-8000-000000008002",
      relationshipType: "018f0000-0000-7000-8000-000000008101",
      relationship: "018f0000-0000-7000-8000-000000008201",
      directSnapshot: "018f0000-0000-7000-8000-000000008301",
      privateSnapshot: "018f0000-0000-7000-8000-000000008302",
      directRun: "018f0000-0000-7000-8000-000000008401",
      privateRun: "018f0000-0000-7000-8000-000000008402",
      privateView: "018f0000-0000-7000-8000-000000008501",
      foreignPerson: "018f0000-0000-7000-8000-000000008601",
      foreignSnapshot: "018f0000-0000-7000-8000-000000008701",
      foreignRun: "018f0000-0000-7000-8000-000000008801",
    } as const;
    await fixture.database.insert(people).values([
      {
        id: ids.source,
        workspaceId: owner.workspaceId,
        displayName: "Visible manifest source",
        sensitivity: "internal",
        createdBy: owner.principalId,
        updatedBy: owner.principalId,
      },
      {
        id: ids.target,
        workspaceId: owner.workspaceId,
        displayName: "Granted manifest target",
        sensitivity: "confidential",
        createdBy: owner.principalId,
        updatedBy: owner.principalId,
      },
      {
        id: ids.foreignPerson,
        workspaceId: foreign.workspaceId,
        displayName: "Foreign manifest person",
        sensitivity: "internal",
        createdBy: foreign.principalId,
        updatedBy: foreign.principalId,
      },
    ]);
    await fixture.database.insert(relationshipTypes).values({
      id: ids.relationshipType,
      workspaceId: owner.workspaceId,
      key: "dashboard-manifest-link",
      forwardLabel: "links",
      inverseLabel: "linked by",
      createdBy: owner.principalId,
      updatedBy: owner.principalId,
    });
    await fixture.database.insert(relationships).values({
      id: ids.relationship,
      workspaceId: owner.workspaceId,
      sourcePersonId: ids.source,
      targetPersonId: ids.target,
      relationshipTypeId: ids.relationshipType,
      sensitivity: "confidential",
      createdBy: owner.principalId,
      updatedBy: owner.principalId,
    });
    const policyId = newId();
    const personGrantId = newId();
    const relationshipGrantId = newId();
    await fixture.database.insert(accessPolicies).values({
      id: policyId,
      workspaceId: owner.workspaceId,
      name: "Dashboard manifest grants",
      sensitivityCeiling: "confidential",
      resourceKinds: ["person", "relationship"],
      roleBindings: {},
      state: "active",
      createdBy: owner.principalId,
      updatedBy: owner.principalId,
    });
    await fixture.database.insert(resourceGrants).values([
      {
        id: personGrantId,
        workspaceId: owner.workspaceId,
        policyId,
        role: "viewer",
        resourceId: ids.target,
        resourceKind: "person",
        createdBy: owner.principalId,
        updatedBy: owner.principalId,
      },
      {
        id: relationshipGrantId,
        workspaceId: owner.workspaceId,
        policyId,
        role: "viewer",
        resourceId: ids.relationship,
        resourceKind: "relationship",
        createdBy: owner.principalId,
        updatedBy: owner.principalId,
      },
    ]);
    await fixture.database.insert(graphViews).values({
      id: ids.privateView,
      workspaceId: owner.workspaceId,
      ownerId: owner.userId,
      name: "Owner-only dashboard analysis",
      filters: {
        mode: "WORKSPACE",
        rootPersonIds: [],
        sensitivities: [],
      },
      sharing: "private",
      createdBy: owner.principalId,
      updatedBy: owner.principalId,
    });
    const manifest = {
      queryInput: {
        mode: "WORKSPACE",
        rootPersonIds: [],
        sensitivities: [],
      },
      includedPersonVersions: { [ids.source]: 1, [ids.target]: 1 },
      includedRelationshipVersions: { [ids.relationship]: 1 },
    } as const;
    await fixture.database.insert(graphSnapshots).values([
      {
        id: ids.directSnapshot,
        workspaceId: owner.workspaceId,
        ...snapshotContract(viewer.principalId),
        ...manifest,
        graphViewId: null,
        createdBy: viewer.principalId,
      },
      {
        id: ids.privateSnapshot,
        workspaceId: owner.workspaceId,
        ...snapshotContract(owner.principalId),
        ...manifest,
        graphViewId: ids.privateView,
        createdBy: owner.principalId,
      },
      {
        id: ids.foreignSnapshot,
        workspaceId: foreign.workspaceId,
        ...snapshotContract(foreign.principalId),
        graphViewId: null,
        queryInput: {
          mode: "WORKSPACE",
          rootPersonIds: [],
          sensitivities: [],
        },
        includedPersonVersions: { [ids.foreignPerson]: 1 },
        includedRelationshipVersions: {},
        createdBy: foreign.principalId,
      },
    ]);
    const createdAt = new Date("2026-08-04T14:00:00.000Z");
    await fixture.database.insert(analysisRuns).values([
      {
        id: ids.directRun,
        workspaceId: owner.workspaceId,
        ...analysisContract(viewer.principalId),
        algorithm: "DEGREE",
        graphSnapshotId: ids.directSnapshot,
        createdAt,
        createdBy: viewer.principalId,
      },
      {
        id: ids.privateRun,
        workspaceId: owner.workspaceId,
        ...analysisContract(owner.principalId),
        algorithm: "DEGREE",
        graphSnapshotId: ids.privateSnapshot,
        createdAt,
        createdBy: owner.principalId,
      },
      {
        id: ids.foreignRun,
        workspaceId: foreign.workspaceId,
        ...analysisContract(foreign.principalId),
        algorithm: "DEGREE",
        graphSnapshotId: ids.foreignSnapshot,
        createdAt,
        createdBy: foreign.principalId,
      },
    ]);

    const recent = async () =>
      fixture.execute<{
        dashboardRecentGraphAnalyses: {
          nodes: Array<{ id: string }>;
          pageInfo: { endCursor: string | null };
        };
      }>({
        jar: viewer.jar,
        query: `query { dashboardRecentGraphAnalyses(first: 10) { nodes { id } pageInfo { endCursor } } }`,
      });
    const visible = await recent();
    expect(visible.body?.errors).toBeUndefined();
    expect(visible.body?.data?.dashboardRecentGraphAnalyses.nodes).toEqual([
      { id: ids.directRun },
    ]);
    expect(JSON.stringify(visible.body)).not.toContain(ids.privateRun);
    expect(JSON.stringify(visible.body)).not.toContain(ids.foreignRun);

    await fixture.database
      .update(resourceGrants)
      .set({ state: "inactive" })
      .where(eq(resourceGrants.id, relationshipGrantId));
    expect(
      (await recent()).body?.data?.dashboardRecentGraphAnalyses.nodes,
    ).toEqual([]);
    await fixture.database
      .update(resourceGrants)
      .set({ state: "active" })
      .where(eq(resourceGrants.id, relationshipGrantId));
    await fixture.database
      .update(resourceGrants)
      .set({ state: "inactive" })
      .where(eq(resourceGrants.id, personGrantId));
    expect(
      (await recent()).body?.data?.dashboardRecentGraphAnalyses.nodes,
    ).toEqual([]);
    await fixture.database
      .update(resourceGrants)
      .set({ state: "active" })
      .where(eq(resourceGrants.id, personGrantId));
    expect(
      (await recent()).body?.data?.dashboardRecentGraphAnalyses.nodes,
    ).toEqual([{ id: ids.directRun }]);

    const cursor =
      visible.body?.data?.dashboardRecentGraphAnalyses.pageInfo.endCursor;
    expect(cursor).toEqual(expect.any(String));
    for (const after of [
      "not-a-cursor",
      `${cursor?.slice(0, -1)}${cursor?.endsWith("a") ? "b" : "a"}`,
    ]) {
      const invalid = await fixture.execute({
        jar: viewer.jar,
        query: `query($after: String) { dashboardRecentGraphAnalyses(first: 1, after: $after) { nodes { id } } }`,
        variables: { after },
      });
      expectGraphQLError(invalid, "VALIDATION_FAILED");
    }
    const foreignCursor = await fixture.execute<{
      dashboardRecentGraphAnalyses: {
        pageInfo: { endCursor: string | null };
      };
    }>({
      jar: foreign.jar,
      query: `query { dashboardRecentGraphAnalyses(first: 1) { pageInfo { endCursor } } }`,
    });
    const wrongWorkspace = await fixture.execute({
      jar: viewer.jar,
      query: `query($after: String) { dashboardRecentGraphAnalyses(first: 1, after: $after) { nodes { id } } }`,
      variables: {
        after:
          foreignCursor.body?.data?.dashboardRecentGraphAnalyses.pageInfo
            .endCursor,
      },
    });
    expectGraphQLError(wrongWorkspace, "VALIDATION_FAILED");

    // Recent-people cursors deliberately follow the existing unsigned,
    // shape-validated research-cursor convention. Malformed values still fail.
    const malformedPeople = await fixture.execute({
      jar: viewer.jar,
      query: `query { dashboardRecentPeople(first: 1, after: "not-a-cursor") { nodes { id } } }`,
    });
    expectGraphQLError(malformedPeople, "VALIDATION_FAILED");
  });

  it("fails closed with stable request IDs when API keys lack dashboard read scopes", async () => {
    const owner = await fixture.createActor();
    const graphScopeCases = [
      {
        missing: "graph",
        permissions: {
          workspace: ["read"],
          person: ["read"],
          relationship: ["read"],
        },
      },
      {
        missing: "person",
        permissions: {
          workspace: ["read"],
          graph: ["read"],
          relationship: ["read"],
        },
      },
      {
        missing: "relationship",
        permissions: {
          workspace: ["read"],
          graph: ["read"],
          person: ["read"],
        },
      },
    ] as const;
    for (const [index, testCase] of graphScopeCases.entries()) {
      const key = await fixture.provisionKey(owner, testCase.permissions);
      const requestId = `0198f27c-d63e-726b-801c-dc751c05390${index}`;
      const result = await fixture.execute({
        apiKey: key.key,
        headers: { "x-request-id": requestId },
        query: `query { graphStatistics { visiblePeople visibleRelationships } }`,
      });
      expectGraphQLError(result, "FORBIDDEN");
      expect(result.requestId).toBe(requestId);
      expect(result.body?.errors?.[0]?.message).toBe(
        "This operation is not permitted.",
      );
      expect(JSON.stringify(result.body)).not.toContain(testCase.missing);
    }

    const key = await fixture.provisionKey(owner, {
      graph: ["read"],
      person: ["read"],
      relationship: ["read"],
    });
    const requestId = "0198f27c-d63e-726b-801c-dc751c0539a4";
    const policy = await fixture.execute({
      apiKey: key.key,
      headers: { "x-request-id": requestId },
      query: `query { workspacePolicySummary { defaultRetentionDays aiEnabled storageEnabled } }`,
    });
    expectGraphQLError(policy, "FORBIDDEN");
    expect(policy.requestId).toBe(requestId);
    expect(policy.body?.errors?.[0]?.message).toBe(
      "This operation is not permitted.",
    );
  });

  it("returns only current-principal AI metadata newest-first with stable cursors", async () => {
    const owner = await fixture.createActor();
    const other = await fixture.createWorkspaceMember(owner, "analyst");
    const foreign = await fixture.createActor();
    const tied = new Date("2026-08-04T12:00:00.000Z");
    const older = new Date("2026-08-03T12:00:00.000Z");
    const ids = {
      currentHigh: "018f0000-0000-7000-8000-00000000a003",
      currentLow: "018f0000-0000-7000-8000-00000000a002",
      currentOlder: "018f0000-0000-7000-8000-00000000a001",
      foreign: "018f0000-0000-7000-8000-00000000a005",
      other: "018f0000-0000-7000-8000-00000000a004",
    } as const;

    const rows = [
      {
        actor: owner,
        createdAt: older,
        id: ids.currentOlder,
        model: "owner-older-model",
      },
      {
        actor: owner,
        createdAt: tied,
        id: ids.currentLow,
        model: "owner-low-model",
      },
      {
        actor: owner,
        createdAt: tied,
        id: ids.currentHigh,
        model: "owner-high-model",
      },
      {
        actor: other,
        createdAt: new Date("2026-08-05T12:00:00.000Z"),
        id: ids.other,
        model: "same-workspace-secret-model",
      },
      {
        actor: foreign,
        createdAt: new Date("2026-08-06T12:00:00.000Z"),
        id: ids.foreign,
        model: "foreign-secret-model",
      },
    ];
    for (const row of rows) {
      const threadId = newId();
      await fixture.database.insert(aiThreads).values({
        id: threadId,
        workspaceId: row.actor.workspaceId,
        ownerId: row.actor.principalId,
        title: "Private test analysis",
        sharing: "private",
        createdAt: row.createdAt,
        updatedAt: row.createdAt,
        createdBy: row.actor.principalId,
        updatedBy: row.actor.principalId,
      });
      await fixture.database.insert(aiRuns).values({
        id: row.id,
        workspaceId: row.actor.workspaceId,
        threadId,
        provider: "OLLAMA",
        baseUrlFingerprint: "71".repeat(32),
        model: row.model,
        promptHash: `sha256:${"72".repeat(32)}`,
        configurationHash: `sha256:${"73".repeat(32)}`,
        state: "completed",
        startedAt: row.createdAt,
        completedAt: row.createdAt,
        errorCode: "provider_timeout",
        createdAt: row.createdAt,
        createdBy: row.actor.principalId,
      });
      if (row.id === ids.currentHigh) {
        await fixture.database.insert(aiMessages).values({
          id: newId(),
          workspaceId: row.actor.workspaceId,
          threadId,
          role: "assistant",
          encryptedContent: "not-a-sealed-answer",
          contentHash: `sha256:${"74".repeat(32)}`,
          createdAt: row.createdAt,
          updatedAt: row.createdAt,
          createdBy: row.actor.principalId,
          updatedBy: row.actor.principalId,
        });
        await fixture.database.insert(aiToolCalls).values({
          id: newId(),
          workspaceId: row.actor.workspaceId,
          aiRunId: row.id,
          approvedToolName: "private.tool",
          redactedArguments: { resultCount: 9876 },
          redactedResultSummary: { resultCount: 8765 },
          state: "completed",
          createdAt: row.createdAt,
        });
      }
    }

    const pageOne = await fixture.execute<{
      dashboardRecentAiAnalyses: {
        nodes: Array<{
          completedAt: string | null;
          createdAt: string;
          id: string;
          model: string;
          provider: string;
          startedAt: string | null;
          state: string;
        }>;
        pageInfo: { endCursor: string | null; hasNextPage: boolean };
      };
    }>({
      jar: owner.jar,
      query: `query { dashboardRecentAiAnalyses(first: 2) { nodes { id provider model state startedAt completedAt createdAt } pageInfo { endCursor hasNextPage } } }`,
    });
    expect(pageOne.body?.errors).toBeUndefined();
    expect(pageOne.body?.data?.dashboardRecentAiAnalyses.nodes).toEqual([
      expect.objectContaining({
        id: ids.currentHigh,
        model: "owner-high-model",
      }),
      expect.objectContaining({ id: ids.currentLow, model: "owner-low-model" }),
    ]);
    expect(pageOne.body?.data?.dashboardRecentAiAnalyses.pageInfo).toEqual({
      endCursor: expect.any(String),
      hasNextPage: true,
    });

    const pageTwo = await fixture.execute<{
      dashboardRecentAiAnalyses: { nodes: Array<{ id: string }> };
    }>({
      jar: owner.jar,
      query: `query($after: String) { dashboardRecentAiAnalyses(first: 2, after: $after) { nodes { id } } }`,
      variables: {
        after: pageOne.body?.data?.dashboardRecentAiAnalyses.pageInfo.endCursor,
      },
    });
    expect(pageTwo.body?.data?.dashboardRecentAiAnalyses.nodes).toEqual([
      { id: ids.currentOlder },
    ]);
    expect(JSON.stringify([pageOne.body, pageTwo.body])).not.toMatch(
      /same-workspace-secret|foreign-secret|provider_timeout|9876|8765|sealed-answer|private\.tool/u,
    );

    const forbiddenProjection = await fixture.execute({
      jar: owner.jar,
      query: `query { dashboardRecentAiAnalyses(first: 1) { nodes { id answer errorCode citations { claimText } toolCalls { name } } } }`,
    });
    expect(forbiddenProjection.body?.data).toBeUndefined();
    expect(
      forbiddenProjection.body?.errors?.map((error) => error.message),
    ).toEqual(
      expect.arrayContaining([
        'Cannot query field "answer" on type "AiRunHistoryItem".',
        'Cannot query field "errorCode" on type "AiRunHistoryItem".',
        'Cannot query field "citations" on type "AiRunHistoryItem".',
        'Cannot query field "toolCalls" on type "AiRunHistoryItem".',
      ]),
    );
  });

  it("rejects invalid AI history bounds and cross-principal cursors", async () => {
    const owner = await fixture.createActor();
    const other = await fixture.createWorkspaceMember(owner, "analyst");
    const threadId = newId();
    const runId = "018f0000-0000-7000-8000-00000000b001";
    await fixture.database.insert(aiThreads).values({
      id: threadId,
      workspaceId: owner.workspaceId,
      ownerId: owner.principalId,
      title: "Cursor binding",
      sharing: "private",
      createdBy: owner.principalId,
      updatedBy: owner.principalId,
    });
    await fixture.database.insert(aiRuns).values({
      id: runId,
      workspaceId: owner.workspaceId,
      threadId,
      provider: "OPENAI",
      baseUrlFingerprint: "75".repeat(32),
      model: "cursor-model",
      promptHash: `sha256:${"76".repeat(32)}`,
      configurationHash: `sha256:${"77".repeat(32)}`,
      createdBy: owner.principalId,
    });
    const ownerPage = await fixture.execute<{
      dashboardRecentAiAnalyses: {
        pageInfo: { endCursor: string | null };
      };
    }>({
      jar: owner.jar,
      query: `query { dashboardRecentAiAnalyses(first: 1) { pageInfo { endCursor } } }`,
    });
    const cursor =
      ownerPage.body?.data?.dashboardRecentAiAnalyses.pageInfo.endCursor;
    expect(cursor).toEqual(expect.any(String));

    for (const first of [0, -1, 11]) {
      const invalid = await fixture.execute({
        jar: owner.jar,
        query: `query($first: Int) { dashboardRecentAiAnalyses(first: $first) { nodes { id } } }`,
        variables: { first },
      });
      expectGraphQLError(invalid, "VALIDATION_FAILED");
    }
    for (const after of [
      "not-a-cursor",
      `${cursor?.slice(0, -1)}${cursor?.endsWith("a") ? "b" : "a"}`,
    ]) {
      const invalid = await fixture.execute({
        jar: owner.jar,
        query: `query($after: String) { dashboardRecentAiAnalyses(first: 1, after: $after) { nodes { id } } }`,
        variables: { after },
      });
      expectGraphQLError(invalid, "VALIDATION_FAILED");
    }
    const wrongPrincipal = await fixture.execute({
      jar: other.jar,
      query: `query($after: String) { dashboardRecentAiAnalyses(first: 1, after: $after) { nodes { id } } }`,
      variables: { after: cursor },
    });
    expectGraphQLError(wrongPrincipal, "VALIDATION_FAILED");
  });
});
