// @vitest-environment node

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import IORedis from "ioredis";
import { eq } from "drizzle-orm";
import { newId } from "@/db/id";

import { people } from "@/db/schema/people";
import { relationshipTypes, relationships } from "@/db/schema/relationships";
import {
  analysisResults,
  analysisRuns,
  graphSnapshots,
  graphViewNodes,
  graphViews,
  personMetrics,
} from "@/db/schema/graph";
import { auditEvents } from "@/db/schema/operations";
import { accessPolicies, resourceGrants } from "@/db/schema/workspaces";
import { OperationLimiter } from "@/graphql/operation-limiter";
import { LocalRedisStore } from "@/lib/redis";

import { expectGraphQLError } from "../support/graphql";
import { ResearchFixture } from "../support/research-fixture";

const liveDescribe = process.env.TEST_DATABASE_URL ? describe : describe.skip;

const ids = {
  hiddenPerson: "018f0000-0000-7000-8000-000000001001",
  source: "018f0000-0000-7000-8000-000000001002",
  target: "018f0000-0000-7000-8000-000000001003",
  type: "018f0000-0000-7000-8000-000000001101",
  hiddenEdge: "018f0000-0000-7000-8000-000000001201",
  visibleEdge: "018f0000-0000-7000-8000-000000001202",
} as const;

function task12SnapshotContract(actorPrincipalId: string) {
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

function task12AnalysisContract(actorPrincipalId: string) {
  return {
    actorPrincipalId,
    actorKind: "USER",
    algorithmVersion: "graphology@0.26.0/degree/humans-v1",
    configurationHash: "44".repeat(32),
    configuration: {
      projection: "authorized-visible-incidence-v1",
    },
    state: "completed",
    startedAt: new Date("2026-08-03T00:00:00.000Z"),
    completedAt: new Date("2026-08-03T00:00:00.000Z"),
  } as const;
}

const GRAPH_QUERY = /* GraphQL */ `
  query GraphTest($filter: GraphFilterInput!) {
    graph(filter: $filter) {
      nodes {
        id
        displayName
      }
      edges {
        id
        source
        target
        directed
        sensitivity
      }
      limits {
        returnedNodeCount
        returnedEdgeCount
        nodesTruncated
        edgesTruncated
      }
    }
  }
`;

liveDescribe("graph API", () => {
  let fixture: ResearchFixture;
  let redis: IORedis | null = null;

  beforeAll(() => {
    const redisUrl = process.env.TEST_REDIS_URL;
    redis = redisUrl
      ? new IORedis(redisUrl, { lazyConnect: true, maxRetriesPerRequest: 1 })
      : null;
    fixture = new ResearchFixture(
      redis
        ? {
            operationLimiter: new OperationLimiter(
              new LocalRedisStore(redis),
              undefined,
              "59".repeat(32),
            ),
          }
        : undefined,
    );
  });
  beforeEach(async () => fixture.reset());
  afterAll(async () => {
    await fixture.close();
    await redis?.quit();
  });

  it("accounts for manifest authorization in GraphQL complexity without blocking supported pages", async () => {
    const actor = await fixture.createActor();

    const supportedList = await fixture.execute<{
      graphAnalysisRuns: { nodes: unknown[] };
    }>({
      jar: actor.jar,
      query: `query { graphAnalysisRuns(first: 100) { nodes { id } } }`,
    });
    expect(supportedList.body).toEqual({
      data: { graphAnalysisRuns: { nodes: [] } },
    });

    const supportedResults = await fixture.execute({
      jar: actor.jar,
      query: `query { graphAnalysisResults(runId: "018f0000-0000-7000-8000-000000000099", first: 100) { nodes { id } } }`,
    });
    expectGraphQLError(supportedResults, "NOT_FOUND");

    const supportedExport = await fixture.execute({
      jar: actor.jar,
      query: `query { graphAnalysisExport(runId: "018f0000-0000-7000-8000-000000000099", format: JSON, first: 1000) { content } }`,
    });
    expectGraphQLError(supportedExport, "NOT_FOUND");

    for (const first of [0, 1_001]) {
      const invalidExport = await fixture.execute({
        jar: actor.jar,
        query: `query { graphAnalysisExport(runId: "018f0000-0000-7000-8000-000000000099", format: JSON, first: ${first}) { content } }`,
      });
      expectGraphQLError(invalidExport, "VALIDATION_FAILED");
      expect(invalidExport.body?.errors?.[0]?.message).toBe(
        "Operation exceeds the allowed complexity.",
      );
    }

    const overBudget = await fixture.execute({
      jar: actor.jar,
      query: `query {
        first: graphAnalysisRuns(first: 100) { nodes { id } }
        second: graphAnalysisRuns(first: 100) { nodes { id } }
      }`,
    });
    expectGraphQLError(overBudget, "VALIDATION_FAILED");
    expect(overBudget.body?.errors?.[0]?.message).toBe(
      "Operation exceeds the allowed complexity.",
    );
  });

  async function seed() {
    const owner = await fixture.createActor();
    await fixture.database.insert(people).values([
      {
        id: ids.hiddenPerson,
        workspaceId: owner.workspaceId,
        displayName: "A Hidden",
        sortName: "A Hidden",
        sensitivity: "confidential",
        createdBy: owner.principalId,
        updatedBy: owner.principalId,
      },
      {
        id: ids.source,
        workspaceId: owner.workspaceId,
        displayName: "B Source",
        sortName: "B Source",
        sensitivity: "internal",
        createdBy: owner.principalId,
        updatedBy: owner.principalId,
      },
      {
        id: ids.target,
        workspaceId: owner.workspaceId,
        displayName: "C Target",
        sortName: "C Target",
        sensitivity: "internal",
        createdBy: owner.principalId,
        updatedBy: owner.principalId,
      },
    ]);
    await fixture.database.insert(relationshipTypes).values({
      id: ids.type,
      workspaceId: owner.workspaceId,
      key: "knows",
      forwardLabel: "knows",
      inverseLabel: "known by",
      directed: true,
      createdBy: owner.principalId,
      updatedBy: owner.principalId,
    });
    await fixture.database.insert(relationships).values([
      {
        id: ids.hiddenEdge,
        workspaceId: owner.workspaceId,
        sourcePersonId: ids.source,
        targetPersonId: ids.target,
        relationshipTypeId: ids.type,
        sensitivity: "confidential",
        createdBy: owner.principalId,
        updatedBy: owner.principalId,
      },
      {
        id: ids.visibleEdge,
        workspaceId: owner.workspaceId,
        sourcePersonId: ids.source,
        targetPersonId: ids.target,
        relationshipTypeId: ids.type,
        sensitivity: "internal",
        createdBy: owner.principalId,
        updatedBy: owner.principalId,
      },
    ]);
    return owner;
  }

  async function createView(
    owner: Awaited<ReturnType<ResearchFixture["createActor"]>>,
    input: {
      filter?: Record<string, unknown>;
      positions?: Array<{ id: string; x: number; y: number }>;
      sharing?: "PRIVATE" | "WORKSPACE";
    } = {},
  ) {
    const result = await fixture.execute<{
      createGraphView: { id: string; version: number };
    }>({
      jar: owner.jar,
      query: `mutation($input: CreateGraphViewInput!) { createGraphView(input: $input) { id version } }`,
      variables: {
        input: {
          name: `View ${crypto.randomUUID()}`,
          filter: input.filter ?? {
            mode: "WORKSPACE",
            nodeLimit: 10,
            edgeLimit: 10,
          },
          positions: input.positions ?? [],
          sharing: input.sharing ?? "PRIVATE",
        },
      },
    });
    expect(result.body?.errors).toBeUndefined();
    return result.body?.data?.createGraphView;
  }

  it("applies person and relationship authorization before public caps", async () => {
    const owner = await seed();
    const peopleResult = await fixture.execute<{
      graph: {
        nodes: Array<{ id: string }>;
        limits: { nodesTruncated: boolean };
      };
    }>({
      jar: owner.jar,
      query: GRAPH_QUERY,
      variables: {
        filter: {
          mode: "WORKSPACE",
          nodeLimit: 1,
          edgeLimit: 0,
          includeIsolates: true,
        },
      },
    });
    expect(peopleResult.body?.errors).toBeUndefined();
    expect(peopleResult.body?.data?.graph.nodes).toEqual([
      { id: ids.source, displayName: "B Source" },
    ]);
    expect(peopleResult.body?.data?.graph.limits.nodesTruncated).toBe(true);

    const edgeResult = await fixture.execute<{
      graph: {
        edges: Array<{ id: string }>;
        limits: { edgesTruncated: boolean; returnedEdgeCount: number };
      };
    }>({
      jar: owner.jar,
      query: GRAPH_QUERY,
      variables: { filter: { mode: "WORKSPACE", nodeLimit: 10, edgeLimit: 1 } },
    });
    expect(edgeResult.body?.errors).toBeUndefined();
    expect(edgeResult.body?.data?.graph.edges).toEqual([
      {
        id: ids.visibleEdge,
        source: ids.source,
        target: ids.target,
        directed: true,
        sensitivity: "INTERNAL",
      },
    ]);
    expect(edgeResult.body?.data?.graph.limits).toMatchObject({
      edgesTruncated: false,
      returnedEdgeCount: 1,
    });
  });

  it("returns one generic miss when any neighborhood root is hidden", async () => {
    const owner = await seed();
    const result = await fixture.execute({
      jar: owner.jar,
      query: GRAPH_QUERY,
      variables: {
        filter: {
          mode: "NEIGHBORHOOD",
          rootPersonIds: [ids.source, ids.hiddenPerson],
          depth: 1,
        },
      },
    });
    expectGraphQLError(result, "NOT_FOUND");
    expect(result.body?.errors?.[0]?.message).not.toContain(ids.hiddenPerson);
  });

  it("allows one maximum graph field but rejects two aliases at the schema budget", async () => {
    const owner = await seed();
    const one = await fixture.execute({
      jar: owner.jar,
      query: `query { graph(filter: { mode: WORKSPACE, nodeLimit: 10000, edgeLimit: 25000 }) { fingerprint } }`,
    });
    expect(one.body?.errors).toBeUndefined();
    const two = await fixture.execute({
      jar: owner.jar,
      query: `query { first: graph(filter: { mode: WORKSPACE, nodeLimit: 10000, edgeLimit: 25000 }) { fingerprint } second: graph(filter: { mode: WORKSPACE, nodeLimit: 10000, edgeLimit: 25000 }) { fingerprint } }`,
    });
    expectGraphQLError(two, "VALIDATION_FAILED");
  });

  it("canonicalizes mixed-case UUID filters and exposes exact relationship states", async () => {
    const owner = await seed();
    const invalidStateEdge = "018f0000-0000-7000-8000-000000001203";
    await fixture.database.insert(relationships).values({
      id: invalidStateEdge,
      workspaceId: owner.workspaceId,
      sourcePersonId: ids.source,
      targetPersonId: ids.target,
      relationshipTypeId: ids.type,
      state: "legacy_invalid_state",
      sensitivity: "internal",
      createdBy: owner.principalId,
      updatedBy: owner.principalId,
    });
    const result = await fixture.execute<{
      graph: {
        nodes: Array<{ id: string }>;
        normalizedFilter: {
          relationshipStates: string[];
          relationshipTypeIds: string[];
          rootPersonIds: string[];
        };
      };
    }>({
      jar: owner.jar,
      query: `query($filter: GraphFilterInput!) { graph(filter: $filter) { nodes { id } normalizedFilter { rootPersonIds relationshipTypeIds relationshipStates } } }`,
      variables: {
        filter: {
          mode: "NEIGHBORHOOD",
          rootPersonIds: [ids.source.toUpperCase()],
          relationshipTypeIds: [ids.type.toUpperCase()],
          relationshipStates: ["ASSERTED"],
          depth: 1,
        },
      },
    });
    expect(result.body?.errors).toBeUndefined();
    expect(result.body?.data?.graph.normalizedFilter).toEqual({
      relationshipStates: ["ASSERTED"],
      relationshipTypeIds: [ids.type],
      rootPersonIds: [ids.source],
    });
    expect(result.body?.data?.graph.nodes.map(({ id }) => id)).toEqual([
      ids.source,
      ids.target,
    ]);

    const unfiltered = await fixture.execute<{
      graph: { edges: Array<{ id: string; state: string }> };
    }>({
      jar: owner.jar,
      query: `query { graph(filter: { mode: WORKSPACE, nodeLimit: 10, edgeLimit: 10 }) { edges { id state } } }`,
    });
    expect(unfiltered.body?.errors).toBeUndefined();
    expect(unfiltered.body?.data?.graph.edges).toEqual([
      { id: ids.visibleEdge, state: "ASSERTED" },
    ]);
  });

  it("permits scoped API-key reads but never API-key view ownership", async () => {
    const owner = await seed();
    const key = await fixture.provisionKey(owner, {
      graph: ["read"],
      person: ["read"],
      relationship: ["read"],
      graphView: ["create", "read"],
    });
    const graph = await fixture.execute<{
      graph: { nodes: Array<{ id: string }> };
    }>({
      apiKey: key.key,
      origin: null,
      query: GRAPH_QUERY,
      variables: {
        filter: { mode: "WORKSPACE", nodeLimit: 10, edgeLimit: 10 },
      },
    });
    expect(graph.body?.errors).toBeUndefined();
    expect(graph.body?.data?.graph.nodes.map(({ id }) => id)).toEqual([
      ids.source,
      ids.target,
    ]);
    const view = await fixture.execute({
      apiKey: key.key,
      origin: null,
      query: `mutation { createGraphView(input: { name: "Denied", filter: { mode: WORKSPACE } }) { id } }`,
    });
    expectGraphQLError(view, "FORBIDDEN");

    const incomplete = await fixture.provisionKey(owner, {
      analysis: ["create", "run"],
      graph: ["read", "run"],
      person: ["read"],
    });
    const deniedSnapshot = await fixture.execute({
      apiKey: incomplete.key,
      origin: null,
      query: `mutation($input: RunGraphAnalysisInput!) {
        createGraphSnapshot(input: $input) { id }
      }`,
      variables: {
        input: {
          algorithm: "DEGREE",
          filter: { mode: "WORKSPACE", nodeLimit: 10, edgeLimit: 10 },
        },
      },
    });
    expectGraphQLError(deniedSnapshot, "FORBIDDEN");

    const complete = await fixture.provisionKey(owner, {
      analysis: ["create", "read", "run"],
      graph: ["read", "run"],
      person: ["read"],
      relationship: ["read"],
    });
    const allowedSnapshot = await fixture.execute<{
      createGraphSnapshot: { algorithm: string; id: string };
    }>({
      apiKey: complete.key,
      origin: null,
      query: `mutation($input: RunGraphAnalysisInput!) {
        createGraphSnapshot(input: $input) { id algorithm }
      }`,
      variables: {
        input: {
          algorithm: "DEGREE",
          filter: { mode: "WORKSPACE", nodeLimit: 10, edgeLimit: 10 },
        },
      },
    });
    expect(allowedSnapshot.body?.errors).toBeUndefined();
    expect(allowedSnapshot.body?.data?.createGraphSnapshot.algorithm).toBe(
      "DEGREE",
    );
  });

  it("owns, versions, audits, and archives saved views transactionally", async () => {
    const owner = await seed();
    const created = await fixture.execute<{
      createGraphView: {
        id: string;
        name: string;
        version: number;
      };
    }>({
      jar: owner.jar,
      query: `mutation($input: CreateGraphViewInput!) { createGraphView(input: $input) { id name version } }`,
      variables: {
        input: {
          name: "  Core   network ",
          filter: { mode: "WORKSPACE", nodeLimit: 10, edgeLimit: 10 },
          sharing: "WORKSPACE",
          positions: [{ id: ids.source, x: 1, y: 2 }],
        },
      },
    });
    expect(created.body?.errors).toBeUndefined();
    expect(created.body?.data?.createGraphView).toMatchObject({
      name: "Core network",
      version: 1,
    });
    const id = created.body?.data?.createGraphView.id;
    expect(id).toEqual(expect.any(String));

    const updated = await fixture.execute<{
      updateGraphView: { id: string; name: string; version: number };
    }>({
      jar: owner.jar,
      query: `mutation($input: UpdateGraphViewInput!) { updateGraphView(input: $input) { id name version } }`,
      variables: { input: { id, expectedVersion: 1, name: "Renamed" } },
    });
    expect(updated.body?.errors).toBeUndefined();
    expect(updated.body?.data?.updateGraphView).toMatchObject({
      id,
      name: "Renamed",
      version: 2,
    });

    const stale = await fixture.execute({
      jar: owner.jar,
      query: `mutation($input: UpdateGraphViewInput!) { updateGraphView(input: $input) { id } }`,
      variables: { input: { id, expectedVersion: 1, name: "Stale" } },
    });
    expectGraphQLError(stale, "CONFLICT");

    const archived = await fixture.execute<{
      archiveGraphView: { id: string; version: number };
    }>({
      jar: owner.jar,
      query: `mutation($input: ArchiveGraphViewInput!) { archiveGraphView(input: $input) { id version } }`,
      variables: { input: { id, expectedVersion: 2 } },
    });
    expect(archived.body?.errors).toBeUndefined();
    expect(archived.body?.data?.archiveGraphView).toEqual({ id, version: 3 });
    expect(await fixture.database.select().from(graphViews)).toHaveLength(1);
    expect(
      (await fixture.database.select().from(auditEvents))
        .filter(({ resourceId }) => resourceId === id)
        .map(({ action }) => action)
        .sort(),
    ).toEqual(["graph_view.archive", "graph_view.create", "graph_view.update"]);
  });

  it("paginates saved-view summaries and caps directly requested visible positions", async () => {
    const owner = await seed();
    const view = await createView(owner, {
      positions: [
        { id: ids.source, x: 1, y: 2 },
        { id: ids.target, x: 3, y: 4 },
      ],
    });
    const secondView = await createView(owner);
    const listed = await fixture.execute<{
      graphViews: {
        nodes: Array<{ id: string; name: string }>;
        pageInfo: { endCursor: string | null; hasNextPage: boolean };
      };
    }>({
      jar: owner.jar,
      query: `query { graphViews(first: 1) { nodes { id name } pageInfo { endCursor hasNextPage } } }`,
    });
    expect(listed.body?.errors).toBeUndefined();
    expect(listed.body?.data?.graphViews.nodes).toHaveLength(1);
    expect(listed.body?.data?.graphViews.pageInfo).toMatchObject({
      endCursor: expect.any(String),
      hasNextPage: true,
    });
    const nextList = await fixture.execute<{
      graphViews: {
        nodes: Array<{ id: string }>;
        pageInfo: { hasNextPage: boolean };
      };
    }>({
      jar: owner.jar,
      query: `query($after: String) { graphViews(first: 1, after: $after) { nodes { id } pageInfo { hasNextPage } } }`,
      variables: { after: listed.body?.data?.graphViews.pageInfo.endCursor },
    });
    expect(nextList.body?.errors).toBeUndefined();
    expect(
      new Set([
        listed.body?.data?.graphViews.nodes[0]?.id,
        nextList.body?.data?.graphViews.nodes[0]?.id,
      ]),
    ).toEqual(new Set([view?.id, secondView?.id]));
    expect(nextList.body?.data?.graphViews.pageInfo.hasNextPage).toBe(false);

    const detail = await fixture.execute<{
      graphView: {
        positions: {
          nodes: Array<{ id: string; x: number; y: number }>;
          pageInfo: { endCursor: string | null; hasNextPage: boolean };
        };
      };
    }>({
      jar: owner.jar,
      query: `query($id: UUID!) { graphView(id: $id) { positions(first: 1) { nodes { id x y } pageInfo { endCursor hasNextPage } } } }`,
      variables: { id: view?.id },
    });
    expect(detail.body?.errors).toBeUndefined();
    expect(detail.body?.data?.graphView.positions.nodes).toEqual([
      { id: ids.source, x: 1, y: 2 },
    ]);
    expect(detail.body?.data?.graphView.positions.pageInfo).toMatchObject({
      endCursor: expect.any(String),
      hasNextPage: true,
    });
    const nextPositions = await fixture.execute<{
      graphView: {
        positions: {
          nodes: Array<{ id: string }>;
          pageInfo: { hasNextPage: boolean };
        };
      };
    }>({
      jar: owner.jar,
      query: `query($id: UUID!, $after: String) { graphView(id: $id) { positions(first: 1, after: $after) { nodes { id } pageInfo { hasNextPage } } } }`,
      variables: {
        id: view?.id,
        after: detail.body?.data?.graphView.positions.pageInfo.endCursor,
      },
    });
    expect(nextPositions.body?.errors).toBeUndefined();
    expect(nextPositions.body?.data?.graphView.positions.nodes).toEqual([
      { id: ids.target },
    ]);
    expect(
      nextPositions.body?.data?.graphView.positions.pageInfo.hasNextPage,
    ).toBe(false);

    const crossViewCursor = await fixture.execute({
      jar: owner.jar,
      query: `query($id: UUID!, $after: String) { graphView(id: $id) { positions(first: 1, after: $after) { nodes { id } } } }`,
      variables: {
        id: secondView?.id,
        after: detail.body?.data?.graphView.positions.pageInfo.endCursor,
      },
    });
    expectGraphQLError(crossViewCursor, "VALIDATION_FAILED");
    const aboveCap = await fixture.execute({
      jar: owner.jar,
      query: `query($id: UUID!) { graphView(id: $id) { positions(first: 251) { nodes { id } } } }`,
      variables: { id: view?.id },
    });
    expectGraphQLError(aboveCap, "VALIDATION_FAILED");
  });

  it("rejects unsafe stored positions without serializing unbounded values", async () => {
    const owner = await seed();
    const view = await createView(owner, {
      positions: [{ id: ids.source, x: 1, y: 2 }],
    });
    await fixture.database
      .update(graphViewNodes)
      .set({ positionX: "1000001" })
      .where(eq(graphViewNodes.graphViewId, view?.id ?? ""));
    const result = await fixture.execute({
      jar: owner.jar,
      query: `query($id: UUID!) { graphView(id: $id) { positions(first: 25) { nodes { id x y } } } }`,
      variables: { id: view?.id },
    });
    expectGraphQLError(result, "VALIDATION_FAILED");
  });

  it("derives analysis filters from authorized views and rejects false attribution", async () => {
    const owner = await seed();
    const view = await createView(owner);
    const before = await fixture.database.select().from(graphSnapshots);
    const result = await fixture.execute({
      jar: owner.jar,
      query: `mutation($input: RunGraphAnalysisInput!) { runGraphAnalysis(input: $input) { run { id } } }`,
      variables: {
        input: {
          algorithm: "DEGREE",
          graphViewId: view?.id,
          filter: { mode: "WORKSPACE", nodeLimit: 9, edgeLimit: 10 },
        },
      },
    });
    expectGraphQLError(result, "VALIDATION_FAILED");
    expect(await fixture.database.select().from(graphSnapshots)).toHaveLength(
      before.length,
    );
    const derived = await fixture.execute<{
      runGraphAnalysis: { graph: { normalizedFilter: { nodeLimit: number } } };
    }>({
      jar: owner.jar,
      query: `mutation($input: RunGraphAnalysisInput!) { runGraphAnalysis(input: $input) { graph { normalizedFilter { nodeLimit } } } }`,
      variables: {
        input: {
          algorithm: "DEGREE",
          graphViewId: view?.id,
        },
      },
    });
    expect(derived.body?.errors).toBeUndefined();
    expect(
      derived.body?.data?.runGraphAnalysis.graph.normalizedFilter.nodeLimit,
    ).toBe(10);
  });

  it("does not expose a private-view snapshot to another workspace member", async () => {
    const owner = await seed();
    const view = await createView(owner);
    const run = await fixture.execute<{
      runGraphAnalysis: { run: { graphSnapshotId: string; id: string } };
    }>({
      jar: owner.jar,
      query: `mutation($input: RunGraphAnalysisInput!) { runGraphAnalysis(input: $input) { run { id graphSnapshotId } } }`,
      variables: {
        input: {
          algorithm: "DEGREE",
          graphViewId: view?.id,
          filter: { mode: "WORKSPACE", nodeLimit: 10, edgeLimit: 10 },
        },
      },
    });
    expect(run.body?.errors).toBeUndefined();
    const member = await fixture.createWorkspaceMember(owner, "analyst");
    const rerun = await fixture.execute({
      jar: member.jar,
      query: `mutation($input: RerunGraphAnalysisInput!) { rerunGraphAnalysis(input: $input) { run { id } } }`,
      variables: {
        input: {
          snapshotId: run.body?.data?.runGraphAnalysis.run.graphSnapshotId,
          algorithm: "DEGREE",
        },
      },
    });
    expectGraphQLError(rerun, "NOT_FOUND");

    const runRead = await fixture.execute({
      jar: member.jar,
      query: `query($id: UUID!) { graphAnalysisRun(id: $id) { id } }`,
      variables: { id: run.body?.data?.runGraphAnalysis.run.id },
    });
    expectGraphQLError(runRead, "NOT_FOUND");
    const runList = await fixture.execute<{
      graphAnalysisRuns: {
        nodes: Array<{ id: string }>;
        pageInfo: { endCursor: string | null; hasNextPage: boolean };
      };
    }>({
      jar: member.jar,
      query: `query { graphAnalysisRuns(first: 25) { nodes { id } pageInfo { endCursor hasNextPage } } }`,
    });
    expect(runList.body?.errors).toBeUndefined();
    expect(runList.body?.data?.graphAnalysisRuns).toEqual({
      nodes: [],
      pageInfo: { endCursor: null, hasNextPage: false },
    });
    const results = await fixture.execute({
      jar: member.jar,
      query: `query($id: UUID!) { graphAnalysisResults(runId: $id, first: 1) { nodes { id } } }`,
      variables: { id: run.body?.data?.runGraphAnalysis.run.id },
    });
    expectGraphQLError(results, "NOT_FOUND");
  });

  it("revokes direct snapshot reads when a manifest relationship is no longer visible", async () => {
    const owner = await seed();
    const created = await fixture.execute<{
      runGraphAnalysis: { run: { id: string } };
    }>({
      jar: owner.jar,
      query: `mutation($input: RunGraphAnalysisInput!) { runGraphAnalysis(input: $input) { run { id } } }`,
      variables: {
        input: {
          algorithm: "DEGREE",
          filter: { mode: "WORKSPACE", nodeLimit: 10, edgeLimit: 10 },
        },
      },
    });
    expect(created.body?.errors).toBeUndefined();
    const runId = created.body?.data?.runGraphAnalysis.run.id;
    const member = await fixture.createWorkspaceMember(owner, "analyst");

    const before = await fixture.execute({
      jar: member.jar,
      query: `query($id: UUID!) { graphAnalysisRun(id: $id) { id } }`,
      variables: { id: runId },
    });
    expect(before.body?.errors).toBeUndefined();

    await fixture.database
      .update(relationships)
      .set({ sensitivity: "confidential" })
      .where(eq(relationships.id, ids.visibleEdge));

    const run = await fixture.execute({
      jar: member.jar,
      query: `query($id: UUID!) { graphAnalysisRun(id: $id) { id } }`,
      variables: { id: runId },
    });
    expectGraphQLError(run, "NOT_FOUND");
    const results = await fixture.execute({
      jar: member.jar,
      query: `query($id: UUID!) { graphAnalysisResults(runId: $id, first: 1) { nodes { id } } }`,
      variables: { id: runId },
    });
    expectGraphQLError(results, "NOT_FOUND");
  });

  it("revokes direct snapshot reads when a root becomes hidden or deleted", async () => {
    const owner = await seed();
    const created = await fixture.execute<{
      runGraphAnalysis: { run: { id: string } };
    }>({
      jar: owner.jar,
      query: `mutation($input: RunGraphAnalysisInput!) { runGraphAnalysis(input: $input) { run { id } } }`,
      variables: {
        input: {
          algorithm: "DEGREE",
          filter: {
            mode: "NEIGHBORHOOD",
            rootPersonIds: [ids.source],
            depth: 1,
            nodeLimit: 10,
            edgeLimit: 10,
          },
        },
      },
    });
    expect(created.body?.errors).toBeUndefined();
    const runId = created.body?.data?.runGraphAnalysis.run.id;
    const member = await fixture.createWorkspaceMember(owner, "analyst");

    await fixture.database
      .update(people)
      .set({ sensitivity: "confidential" })
      .where(eq(people.id, ids.source));
    expectGraphQLError(
      await fixture.execute({
        jar: member.jar,
        query: `query($id: UUID!) { graphAnalysisRun(id: $id) { id } }`,
        variables: { id: runId },
      }),
      "NOT_FOUND",
    );

    await fixture.database
      .update(people)
      .set({ deletedAt: new Date(), sensitivity: "internal" })
      .where(eq(people.id, ids.source));
    expectGraphQLError(
      await fixture.execute({
        jar: member.jar,
        query: `query($id: UUID!) { graphAnalysisRun(id: $id) { id } }`,
        variables: { id: runId },
      }),
      "NOT_FOUND",
    );
  });

  it("authorizes direct snapshot manifests in SQL before the analysis-run page limit", async () => {
    const owner = await seed();
    const member = await fixture.createWorkspaceMember(owner, "analyst");
    const hiddenSnapshots = Array.from({ length: 20 }, (_, index) => ({
      id: `018f5100-0000-7000-8000-${(index + 1)
        .toString(16)
        .padStart(12, "0")}`,
      workspaceId: owner.workspaceId,
      ...task12SnapshotContract(owner.principalId),
      graphViewId: null,
      queryInput: {
        mode: "NEIGHBORHOOD",
        rootPersonIds: [ids.source],
        depth: 1,
        sensitivities: [],
      },
      includedPersonVersions: { [ids.source]: 1 },
      includedRelationshipVersions: {},
      createdBy: owner.principalId,
    }));
    const visibleSnapshotId = "018f5100-0000-7000-8000-ffffffffffff";
    await fixture.database.insert(graphSnapshots).values([
      ...hiddenSnapshots,
      {
        id: visibleSnapshotId,
        workspaceId: owner.workspaceId,
        ...task12SnapshotContract(member.principalId),
        graphViewId: null,
        queryInput: { mode: "WORKSPACE", rootPersonIds: [], sensitivities: [] },
        includedPersonVersions: { [ids.target]: 1 },
        includedRelationshipVersions: {},
        createdBy: member.principalId,
      },
    ]);
    await fixture.database.insert(analysisRuns).values([
      ...hiddenSnapshots.map((snapshot, index) => ({
        id: `018f6100-0000-7000-8000-${(index + 1)
          .toString(16)
          .padStart(12, "0")}`,
        workspaceId: owner.workspaceId,
        ...task12AnalysisContract(owner.principalId),
        algorithm: "DEGREE",
        graphSnapshotId: snapshot.id,
        state: "completed",
        createdBy: owner.principalId,
      })),
      {
        id: "018f6100-0000-7000-8000-ffffffffffff",
        workspaceId: owner.workspaceId,
        ...task12AnalysisContract(member.principalId),
        algorithm: "DEGREE",
        graphSnapshotId: visibleSnapshotId,
        state: "completed",
        createdBy: member.principalId,
      },
    ]);
    await fixture.database
      .update(people)
      .set({ sensitivity: "confidential" })
      .where(eq(people.id, ids.source));

    fixture.queryCount = 0;
    const result = await fixture.execute<{
      graphAnalysisRuns: {
        nodes: Array<{ id: string }>;
        pageInfo: { hasNextPage: boolean };
      };
    }>({
      jar: member.jar,
      query: `query { graphAnalysisRuns(first: 1) { nodes { id } pageInfo { hasNextPage } } }`,
    });
    expect(result.body?.errors).toBeUndefined();
    expect(result.body?.data?.graphAnalysisRuns).toEqual({
      nodes: [{ id: "018f6100-0000-7000-8000-ffffffffffff" }],
      pageInfo: { hasNextPage: false },
    });
    expect(fixture.queryCount).toBeLessThanOrEqual(12);
  });

  it("paginates point analysis results with an opaque advancing cursor", async () => {
    const owner = await seed();
    const created = await fixture.execute<{
      runGraphAnalysis: { run: { id: string } };
    }>({
      jar: owner.jar,
      query: `mutation($input: RunGraphAnalysisInput!) { runGraphAnalysis(input: $input) { run { id } } }`,
      variables: {
        input: {
          algorithm: "DEGREE",
          filter: { mode: "WORKSPACE", nodeLimit: 10, edgeLimit: 10 },
        },
      },
    });
    const runId = created.body?.data?.runGraphAnalysis.run.id;
    const first = await fixture.execute<{
      graphAnalysisResults: {
        nodes: Array<{ id: string; rank: number }>;
        pageInfo: { endCursor: string | null; hasNextPage: boolean };
      };
    }>({
      jar: owner.jar,
      query: `query($runId: UUID!) { graphAnalysisResults(runId: $runId, first: 1) { nodes { id rank } pageInfo { endCursor hasNextPage } } }`,
      variables: { runId },
    });
    expect(first.body?.errors).toBeUndefined();
    expect(first.body?.data?.graphAnalysisResults.nodes).toHaveLength(1);
    expect(first.body?.data?.graphAnalysisResults.pageInfo).toMatchObject({
      endCursor: expect.any(String),
      hasNextPage: true,
    });
    const second = await fixture.execute<{
      graphAnalysisResults: {
        nodes: Array<{ id: string }>;
        pageInfo: { hasNextPage: boolean };
      };
    }>({
      jar: owner.jar,
      query: `query($runId: UUID!, $after: String) { graphAnalysisResults(runId: $runId, first: 1, after: $after) { nodes { id } pageInfo { hasNextPage } } }`,
      variables: {
        runId,
        after: first.body?.data?.graphAnalysisResults.pageInfo.endCursor,
      },
    });
    expect(second.body?.errors).toBeUndefined();
    expect(second.body?.data?.graphAnalysisResults.nodes).toHaveLength(1);
    expect(second.body?.data?.graphAnalysisResults.nodes[0]?.id).not.toBe(
      first.body?.data?.graphAnalysisResults.nodes[0]?.id,
    );
    expect(second.body?.data?.graphAnalysisResults.pageInfo.hasNextPage).toBe(
      false,
    );

    const cursor = first.body?.data?.graphAnalysisResults.pageInfo.endCursor;
    if (!cursor || !runId)
      throw new Error("Analysis result cursor fixture failed.");
    const tampered = `${cursor.slice(0, -1)}${cursor.endsWith("a") ? "b" : "a"}`;
    expectGraphQLError(
      await fixture.execute({
        jar: owner.jar,
        query: `query($runId: UUID!, $after: String) { graphAnalysisResults(runId: $runId, first: 1, after: $after) { nodes { id } } }`,
        variables: { runId, after: tampered },
      }),
      "VALIDATION_FAILED",
    );
    expectGraphQLError(
      await fixture.execute({
        jar: owner.jar,
        query: `query($after: String) { graphAnalysisRuns(first: 1, after: $after) { nodes { id } } }`,
        variables: { after: cursor },
      }),
      "VALIDATION_FAILED",
    );
    expectGraphQLError(
      await fixture.execute({
        jar: owner.jar,
        query: `query($runId: UUID!, $after: String) { graphAnalysisResults(runId: $runId, first: 1, after: $after) { nodes { id } } }`,
        variables: { runId: newId(), after: cursor },
      }),
      "VALIDATION_FAILED",
    );
    const foreign = await fixture.createActor();
    expectGraphQLError(
      await fixture.execute({
        jar: foreign.jar,
        query: `query($runId: UUID!, $after: String) { graphAnalysisResults(runId: $runId, first: 1, after: $after) { nodes { id } } }`,
        variables: { runId, after: cursor },
      }),
      "VALIDATION_FAILED",
    );
  });

  it("authorizes saved-view and analysis-run pages in SQL before their limits", async () => {
    const owner = await seed();
    const hiddenRootViews = Array.from({ length: 20 }, (_, index) => ({
      id: `018f7000-0000-7000-8000-${(index + 1)
        .toString(16)
        .padStart(12, "0")}`,
      workspaceId: owner.workspaceId,
      ownerId: owner.userId,
      name: `A Hidden ${index.toString().padStart(2, "0")}`,
      filters: {
        mode: "NEIGHBORHOOD",
        rootPersonIds: [ids.source],
        depth: 1,
        nodeLimit: 10,
        edgeLimit: 10,
      },
      createdBy: owner.principalId,
      updatedBy: owner.principalId,
    }));
    const visibleView = {
      id: "018f7000-0000-7000-8000-ffffffffffff",
      workspaceId: owner.workspaceId,
      ownerId: owner.userId,
      name: "Z Visible",
      filters: { mode: "WORKSPACE", nodeLimit: 10, edgeLimit: 10 },
      createdBy: owner.principalId,
      updatedBy: owner.principalId,
    };
    await fixture.database
      .insert(graphViews)
      .values([...hiddenRootViews, visibleView]);
    await fixture.database
      .update(people)
      .set({ sensitivity: "confidential" })
      .where(eq(people.id, ids.source));

    fixture.queryCount = 0;
    const views = await fixture.execute<{
      graphViews: {
        nodes: Array<{ id: string }>;
        pageInfo: { hasNextPage: boolean };
      };
    }>({
      jar: owner.jar,
      query: `query { graphViews(first: 1) { nodes { id } pageInfo { hasNextPage } } }`,
    });
    expect(views.body?.errors).toBeUndefined();
    expect(views.body?.data?.graphViews.nodes).toEqual([
      { id: visibleView.id },
    ]);
    expect(fixture.queryCount).toBeLessThanOrEqual(12);

    const member = await fixture.createWorkspaceMember(owner, "analyst");
    const pinnedViewId = "018f7000-0000-7000-8001-000000000001";
    await fixture.database.insert(graphViews).values({
      id: pinnedViewId,
      workspaceId: owner.workspaceId,
      ownerId: owner.userId,
      name: "Workspace pinned hidden person",
      filters: { mode: "WORKSPACE", nodeLimit: 10, edgeLimit: 10 },
      sharing: "workspace",
      createdBy: owner.principalId,
      updatedBy: owner.principalId,
    });
    await fixture.database.insert(graphViewNodes).values({
      id: "018f7000-0000-7000-8002-000000000001",
      workspaceId: owner.workspaceId,
      graphViewId: pinnedViewId,
      personId: ids.source,
      positionX: "1",
      positionY: "2",
      createdBy: owner.principalId,
      updatedBy: owner.principalId,
    });
    const hiddenSnapshots = Array.from({ length: 100 }, (_, index) => ({
      id: `018f5000-0000-7000-8000-${(index + 1)
        .toString(16)
        .padStart(12, "0")}`,
      workspaceId: owner.workspaceId,
      ...task12SnapshotContract(owner.principalId),
      graphViewId: pinnedViewId,
      queryInput: { mode: "WORKSPACE", rootPersonIds: [], sensitivities: [] },
      includedPersonVersions: {},
      includedRelationshipVersions: {},
      createdBy: owner.principalId,
    }));
    const visibleSnapshotId = "018f5000-0000-7000-8000-ffffffffffff";
    await fixture.database.insert(graphSnapshots).values([
      ...hiddenSnapshots,
      {
        id: visibleSnapshotId,
        workspaceId: owner.workspaceId,
        ...task12SnapshotContract(member.principalId),
        graphViewId: null,
        queryInput: {
          mode: "WORKSPACE",
          rootPersonIds: [],
          sensitivities: [],
        },
        includedPersonVersions: {},
        includedRelationshipVersions: {},
        createdBy: member.principalId,
      },
    ]);
    await fixture.database.insert(analysisRuns).values([
      ...hiddenSnapshots.map((snapshot, index) => ({
        id: `018f6000-0000-7000-8000-${(index + 1)
          .toString(16)
          .padStart(12, "0")}`,
        workspaceId: owner.workspaceId,
        ...task12AnalysisContract(owner.principalId),
        algorithm: "DEGREE",
        graphSnapshotId: snapshot.id,
        createdBy: owner.principalId,
      })),
      {
        id: "018f6000-0000-7000-8000-ffffffffffff",
        workspaceId: owner.workspaceId,
        ...task12AnalysisContract(member.principalId),
        algorithm: "DEGREE",
        graphSnapshotId: visibleSnapshotId,
        createdBy: member.principalId,
      },
    ]);

    fixture.queryCount = 0;
    const runs = await fixture.execute<{
      graphAnalysisRuns: {
        nodes: Array<{ id: string }>;
        pageInfo: { endCursor: string | null; hasNextPage: boolean };
      };
    }>({
      jar: member.jar,
      query: `query { graphAnalysisRuns(first: 1) { nodes { id } pageInfo { endCursor hasNextPage } } }`,
    });
    expect(runs.body?.errors).toBeUndefined();
    expect(runs.body?.data?.graphAnalysisRuns.nodes).toEqual([
      { id: "018f6000-0000-7000-8000-ffffffffffff" },
    ]);
    expect(runs.body?.data?.graphAnalysisRuns.pageInfo).toEqual({
      endCursor: expect.any(String),
      hasNextPage: false,
    });
    expect(fixture.queryCount).toBeLessThanOrEqual(12);
  });

  it("reauthorizes archived views and changed root or pinned-person visibility", async () => {
    const owner = await seed();
    const rootView = await createView(owner, {
      filter: {
        mode: "NEIGHBORHOOD",
        rootPersonIds: [ids.source],
        depth: 1,
        nodeLimit: 10,
        edgeLimit: 10,
      },
    });
    await fixture.database
      .update(people)
      .set({ sensitivity: "confidential" })
      .where(eq(people.id, ids.source));
    const rootResult = await fixture.execute({
      jar: owner.jar,
      query: `mutation($input: RunGraphAnalysisInput!) { runGraphAnalysis(input: $input) { run { id } } }`,
      variables: {
        input: {
          algorithm: "DEGREE",
          graphViewId: rootView?.id,
          filter: {
            mode: "NEIGHBORHOOD",
            rootPersonIds: [ids.source],
            depth: 1,
            nodeLimit: 10,
            edgeLimit: 10,
          },
        },
      },
    });
    expectGraphQLError(rootResult, "NOT_FOUND");

    await fixture.database
      .update(people)
      .set({ sensitivity: "internal" })
      .where(eq(people.id, ids.source));
    const pinnedView = await createView(owner, {
      positions: [{ id: ids.target, x: 1, y: 2 }],
    });
    await fixture.database
      .update(people)
      .set({ sensitivity: "confidential" })
      .where(eq(people.id, ids.target));
    const pinResult = await fixture.execute({
      jar: owner.jar,
      query: `mutation($input: RunGraphAnalysisInput!) { runGraphAnalysis(input: $input) { run { id } } }`,
      variables: {
        input: {
          algorithm: "DEGREE",
          graphViewId: pinnedView?.id,
          filter: { mode: "WORKSPACE", nodeLimit: 10, edgeLimit: 10 },
        },
      },
    });
    expectGraphQLError(pinResult, "NOT_FOUND");

    await fixture.database
      .update(people)
      .set({ sensitivity: "internal" })
      .where(eq(people.id, ids.target));
    const archivedView = await createView(owner);
    const archivedViewRun = await fixture.execute<{
      runGraphAnalysis: { run: { graphSnapshotId: string } };
    }>({
      jar: owner.jar,
      query: `mutation($input: RunGraphAnalysisInput!) { runGraphAnalysis(input: $input) { run { graphSnapshotId } } }`,
      variables: {
        input: {
          algorithm: "DEGREE",
          graphViewId: archivedView?.id,
        },
      },
    });
    expect(archivedViewRun.body?.errors).toBeUndefined();
    const archived = await fixture.execute({
      jar: owner.jar,
      query: `mutation($input: ArchiveGraphViewInput!) { archiveGraphView(input: $input) { id } }`,
      variables: { input: { id: archivedView?.id, expectedVersion: 1 } },
    });
    expect(archived.body?.errors).toBeUndefined();
    const archivedResult = await fixture.execute({
      jar: owner.jar,
      query: `mutation($input: RunGraphAnalysisInput!) { runGraphAnalysis(input: $input) { run { id } } }`,
      variables: {
        input: {
          algorithm: "DEGREE",
          graphViewId: archivedView?.id,
          filter: { mode: "WORKSPACE", nodeLimit: 10, edgeLimit: 10 },
        },
      },
    });
    expectGraphQLError(archivedResult, "NOT_FOUND");
    const archivedRerun = await fixture.execute({
      jar: owner.jar,
      query: `mutation($input: RerunGraphAnalysisInput!) { rerunGraphAnalysis(input: $input) { run { id } } }`,
      variables: {
        input: {
          snapshotId:
            archivedViewRun.body?.data?.runGraphAnalysis.run.graphSnapshotId,
          algorithm: "DEGREE",
        },
      },
    });
    expectGraphQLError(archivedRerun, "PRECONDITION_FAILED");
    expect(archivedRerun.body?.errors?.[0]?.message).toBe(
      "The graph snapshot is no longer reproducible.",
    );
  });

  it("allows the exact analysis boundary and safely rejects one node over it", async () => {
    const owner = await seed();
    const exact = await fixture.execute({
      jar: owner.jar,
      query: `mutation($input: RunGraphAnalysisInput!) { runGraphAnalysis(input: $input) { run { id } } }`,
      variables: {
        input: {
          algorithm: "PAGERANK",
          filter: {
            mode: "WORKSPACE",
            nodeLimit: 2_000,
            edgeLimit: 10_000,
          },
        },
      },
    });
    expect(exact.body?.errors).toBeUndefined();
    const over = await fixture.execute({
      jar: owner.jar,
      query: `mutation($input: RunGraphAnalysisInput!) { runGraphAnalysis(input: $input) { run { id } } }`,
      variables: {
        input: {
          algorithm: "PAGERANK",
          filter: {
            mode: "WORKSPACE",
            nodeLimit: 2_001,
            edgeLimit: 10_000,
          },
        },
      },
    });
    expectGraphQLError(over, "VALIDATION_FAILED");
    expect(await fixture.database.select().from(analysisRuns)).toHaveLength(1);
  });

  it("rejects truncated node and edge selections and recovers after the additions are removed", async () => {
    const owner = await seed();
    const createSnapshot = (nodeLimit: number, edgeLimit: number) =>
      fixture.execute<{ createGraphSnapshot: { id: string } }>({
        jar: owner.jar,
        query: `mutation($input: RunGraphAnalysisInput!) { createGraphSnapshot(input: $input) { id } }`,
        variables: {
          input: {
            algorithm: "DEGREE",
            filter: {
              mode: "WORKSPACE",
              includeIsolates: true,
              nodeLimit,
              edgeLimit,
            },
          },
        },
      });
    const replay = (snapshotId: string) =>
      fixture.execute({
        jar: owner.jar,
        query: `mutation($input: ReplayGraphSnapshotInput!) { replayGraphSnapshot(input: $input) { valid snapshot { id } } }`,
        variables: { input: { snapshotId } },
      });

    const exactNodes = await createSnapshot(2, 10);
    const exactNodeSnapshotId = exactNodes.body?.data?.createGraphSnapshot.id;
    if (!exactNodeSnapshotId)
      throw new Error("Node-cap snapshot fixture failed.");
    const addedPerson = await fixture.createPerson(owner, {
      displayName: "Node cap addition",
    });
    const addedPersonId = addedPerson.body?.data?.createPerson?.person?.id;
    if (!addedPersonId) throw new Error("Node-cap addition fixture failed.");
    const truncatedNodes = await createSnapshot(2, 10);
    expectGraphQLError(truncatedNodes, "VALIDATION_FAILED");
    expect((await replay(exactNodeSnapshotId)).body).toEqual({
      data: { replayGraphSnapshot: { snapshot: null, valid: false } },
    });
    await fixture.database
      .update(people)
      .set({ deletedAt: new Date() })
      .where(eq(people.id, addedPersonId));
    expect((await createSnapshot(2, 10)).body?.errors).toBeUndefined();

    const exactEdges = await createSnapshot(10, 1);
    const exactEdgeSnapshotId = exactEdges.body?.data?.createGraphSnapshot.id;
    if (!exactEdgeSnapshotId)
      throw new Error("Edge-cap snapshot fixture failed.");
    const addedRelationshipId = newId();
    await fixture.database.insert(relationships).values({
      id: addedRelationshipId,
      workspaceId: owner.workspaceId,
      sourcePersonId: ids.target,
      targetPersonId: ids.source,
      relationshipTypeId: ids.type,
      sensitivity: "internal",
      createdBy: owner.principalId,
      updatedBy: owner.principalId,
    });
    const truncatedEdges = await createSnapshot(10, 1);
    expectGraphQLError(truncatedEdges, "VALIDATION_FAILED");
    expect((await replay(exactEdgeSnapshotId)).body).toEqual({
      data: { replayGraphSnapshot: { snapshot: null, valid: false } },
    });
    await fixture.database
      .update(relationships)
      .set({ deletedAt: new Date(), deletedBy: owner.principalId })
      .where(eq(relationships.id, addedRelationshipId));
    expect((await createSnapshot(10, 1)).body?.errors).toBeUndefined();
  });

  it("persists the exact 10,000-node Degree boundary on PostgreSQL", async () => {
    const owner = await seed();
    for (let start = 1; start <= 9_998; start += 500) {
      await fixture.database.insert(people).values(
        Array.from({ length: Math.min(500, 9_999 - start) }, (_, offset) => {
          const index = start + offset;
          return {
            id: `018f4000-0000-7000-8000-${index
              .toString(16)
              .padStart(12, "0")}`,
            workspaceId: owner.workspaceId,
            displayName: `Boundary Person ${index}`,
            sortName: `Boundary ${index.toString().padStart(5, "0")}`,
            sensitivity: "internal" as const,
            createdBy: owner.principalId,
            updatedBy: owner.principalId,
          };
        }),
      );
    }

    const result = await fixture.execute<{
      runGraphAnalysis: {
        metrics: Array<{ personId: string }>;
        run: { id: string };
      };
    }>({
      jar: owner.jar,
      query: `mutation($input: RunGraphAnalysisInput!) { runGraphAnalysis(input: $input) { run { id } metrics { personId } } }`,
      variables: {
        input: {
          algorithm: "DEGREE",
          filter: {
            mode: "WORKSPACE",
            nodeLimit: 10_000,
            edgeLimit: 25_000,
            includeIsolates: true,
          },
        },
      },
    });

    expect(result.body?.errors).toBeUndefined();
    expect(result.body?.data?.runGraphAnalysis.metrics).toHaveLength(10_000);
    expect(await fixture.database.select().from(analysisResults)).toHaveLength(
      10_000,
    );
    expect(await fixture.database.select().from(personMetrics)).toHaveLength(
      10_000,
    );
  }, 120_000);

  it("persists a coherent bounded analysis snapshot, results, metrics, and audit", async () => {
    const owner = await seed();
    const result = await fixture.execute<{
      runGraphAnalysis: {
        run: {
          id: string;
          graphSnapshotId: string;
          state: string;
          algorithm: string;
        };
        metrics: Array<{
          personId: string;
          metricKey: string;
          value: number;
          algorithmVersion: string;
        }>;
        graph: { fingerprint: string };
      };
    }>({
      jar: owner.jar,
      query: `mutation($input: RunGraphAnalysisInput!) { runGraphAnalysis(input: $input) { run { id graphSnapshotId state algorithm } metrics { personId metricKey value algorithmVersion } graph { fingerprint } } }`,
      variables: {
        input: {
          algorithm: "DEGREE",
          filter: { mode: "WORKSPACE", nodeLimit: 10, edgeLimit: 10 },
        },
      },
    });
    expect(result.body?.errors).toBeUndefined();
    expect(result.body?.data?.runGraphAnalysis.run).toMatchObject({
      state: "completed",
      algorithm: "DEGREE",
    });
    expect(result.body?.data?.runGraphAnalysis.metrics).toHaveLength(2);
    expect(
      result.body?.data?.runGraphAnalysis.metrics.every(
        ({ algorithmVersion }) =>
          algorithmVersion === "graphology@0.26.0/degree/humans-v1",
      ),
    ).toBe(true);
    expect(result.body?.data?.runGraphAnalysis.graph.fingerprint).toMatch(
      /^[0-9a-f]{64}$/u,
    );
    expect(await fixture.database.select().from(graphSnapshots)).toHaveLength(
      1,
    );
    expect(await fixture.database.select().from(analysisRuns)).toHaveLength(1);
    expect(await fixture.database.select().from(analysisResults)).toHaveLength(
      2,
    );
    expect(await fixture.database.select().from(personMetrics)).toHaveLength(2);
    expect(
      (await fixture.database.select().from(auditEvents)).filter(
        ({ action }) => action === "graph_analysis.run",
      ),
    ).toHaveLength(1);
    const completedRunId = result.body?.data?.runGraphAnalysis.run.id;
    if (!completedRunId) throw new Error("Completed analysis fixture failed.");
    await expect(
      fixture.connection`
        INSERT INTO analysis_results (
          id, workspace_id, analysis_run_id, result_kind, payload_schema,
          payload_hash, export_label, numeric_value, rank
        ) VALUES (
          ${newId()}, ${owner.workspaceId}, ${completedRunId}, 'degree',
          'humans.graph-analysis-result.v1', ${"55".repeat(32)}, 'degree', 1, 1
        )
      `,
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      fixture.connection`
        UPDATE analysis_results SET numeric_value = 42
        WHERE analysis_run_id = ${completedRunId}
      `,
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      fixture.connection`
        DELETE FROM analysis_results WHERE analysis_run_id = ${completedRunId}
      `,
    ).rejects.toMatchObject({ code: "23514" });

    await fixture.database
      .update(people)
      .set({ version: 2 })
      .where(eq(people.id, ids.source));
    const drifted = await fixture.execute({
      jar: owner.jar,
      query: `mutation($input: RerunGraphAnalysisInput!) { rerunGraphAnalysis(input: $input) { run { id } } }`,
      variables: {
        input: {
          snapshotId: result.body?.data?.runGraphAnalysis.run.graphSnapshotId,
          algorithm: "DEGREE",
        },
      },
    });
    expectGraphQLError(drifted, "PRECONDITION_FAILED");
    expect(await fixture.database.select().from(analysisRuns)).toHaveLength(1);
  });

  it("enforces actor-kind, JSON, algorithm, timing, and immutability contracts in PostgreSQL", async () => {
    const owner = await seed();
    const snapshotId = newId();
    await fixture.database.insert(graphSnapshots).values({
      id: snapshotId,
      workspaceId: owner.workspaceId,
      ...task12SnapshotContract(owner.principalId),
      graphViewId: null,
      queryInput: { mode: "WORKSPACE", rootPersonIds: [], sensitivities: [] },
      includedPersonVersions: {},
      includedRelationshipVersions: {},
      createdBy: owner.principalId,
    });

    await expect(
      fixture.connection`
        INSERT INTO graph_snapshots (
          id, workspace_id, manifest_schema, manifest_hash, manifest_material,
          query_input, query_hash, authorization_hash, actor_principal_id,
          actor_kind, included_person_versions, included_relationship_versions,
          included_relationship_type_versions, algorithm, algorithm_version,
          algorithm_config_hash, algorithm_configuration, runtime_contract,
          created_by
        ) VALUES (
          ${newId()}, ${owner.workspaceId}, 'humans.graph-snapshot-manifest.v1',
          ${"11".repeat(32)}, '{}'::jsonb, '{}'::jsonb, ${"22".repeat(32)},
          ${"33".repeat(32)}, ${owner.principalId}, 'USER', '{}'::jsonb,
          '{}'::jsonb, '{}'::jsonb, 'DEGREE', 'fixed-v1', ${"44".repeat(32)},
          '{"projection":"v1"}'::jsonb,
          '{"serviceVersion":"0.1.0"}'::jsonb, ${owner.principalId}
        )
      `,
    ).rejects.toMatchObject({ code: "23514" });

    await expect(
      fixture.connection`
        INSERT INTO graph_snapshots (
          id, workspace_id, manifest_schema, manifest_hash, manifest_material, query_input,
          query_hash, authorization_hash, actor_principal_id, actor_kind,
          included_person_versions, included_relationship_versions,
          included_relationship_type_versions, algorithm, algorithm_version,
          algorithm_config_hash, algorithm_configuration, runtime_contract,
          created_by
        ) VALUES (
          ${newId()}, ${owner.workspaceId}, 'humans.graph-snapshot-manifest.v1',
          ${"11".repeat(32)}, '{"fixture":"invalid-actor-kind"}'::jsonb,
          '{}'::jsonb, ${"22".repeat(32)},
          ${"33".repeat(32)}, ${owner.principalId}, 'API_KEY', '{}'::jsonb,
          '{}'::jsonb, '{}'::jsonb, 'DEGREE', 'fixed-v1', ${"44".repeat(32)},
          '{"projection":"v1"}'::jsonb, '{"serviceVersion":"0.1.0"}'::jsonb,
          ${owner.principalId}
        )
      `,
    ).rejects.toMatchObject({ code: "23514" });

    await expect(
      fixture.connection`
        UPDATE graph_snapshots SET manifest_hash = ${"55".repeat(32)}
        WHERE id = ${snapshotId}
      `,
    ).rejects.toMatchObject({ code: "23514" });

    await expect(
      fixture.connection`
        INSERT INTO analysis_runs (
          id, workspace_id, algorithm, algorithm_version, configuration_hash,
          graph_snapshot_id, actor_principal_id, actor_kind, configuration,
          state, created_by
        ) VALUES (
          ${newId()}, ${owner.workspaceId}, 'UNBOUNDED', 'v1', ${"44".repeat(32)},
          ${snapshotId}, ${owner.principalId}, 'USER', '{"bounded":true}'::jsonb,
          'pending', ${owner.principalId}
        )
      `,
    ).rejects.toMatchObject({ code: "23514" });

    await expect(
      fixture.connection`
        INSERT INTO analysis_runs (
          id, workspace_id, algorithm, algorithm_version, configuration_hash,
          graph_snapshot_id, actor_principal_id, actor_kind, configuration,
          state, created_by
        ) VALUES (
          ${newId()}, ${owner.workspaceId}, 'DEGREE', 'v1', ${"44".repeat(32)},
          ${snapshotId}, ${owner.principalId}, 'USER', '{"bounded":true}'::jsonb,
          'completed', ${owner.principalId}
        )
      `,
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("creates, reads, replays, creates new analyses, and exports without replacing an invalid snapshot", async () => {
    const owner = await seed();
    const created = await fixture.execute<{
      createGraphSnapshot: {
        algorithm: string;
        algorithmConfigHash: string;
        id: string;
        manifestHash: string;
      };
    }>({
      jar: owner.jar,
      query: `mutation($input: RunGraphAnalysisInput!) {
        createGraphSnapshot(input: $input) {
          id manifestHash algorithm algorithmConfigHash
        }
      }`,
      variables: {
        input: {
          algorithm: "DEGREE",
          filter: { mode: "WORKSPACE", nodeLimit: 10, edgeLimit: 10 },
        },
      },
    });
    expect(created.body?.errors).toBeUndefined();
    const snapshotId = created.body?.data?.createGraphSnapshot.id;
    expect(created.body?.data?.createGraphSnapshot).toMatchObject({
      algorithm: "DEGREE",
      algorithmConfigHash: expect.stringMatching(/^[0-9a-f]{64}$/u),
      manifestHash: expect.stringMatching(/^[0-9a-f]{64}$/u),
    });

    const read = await fixture.execute({
      jar: owner.jar,
      query: `query($id: UUID!) { graphSnapshot(id: $id) { id algorithm manifestHash } }`,
      variables: { id: snapshotId },
    });
    expect(read.body?.errors).toBeUndefined();
    expect(read.body?.data?.graphSnapshot).toMatchObject({
      algorithm: "DEGREE",
      id: snapshotId,
    });
    const replay = await fixture.execute({
      jar: owner.jar,
      query: `mutation($input: ReplayGraphSnapshotInput!) {
        replayGraphSnapshot(input: $input) { valid snapshot { id } }
      }`,
      variables: { input: { snapshotId } },
    });
    expect(replay.body).toEqual({
      data: {
        replayGraphSnapshot: { snapshot: { id: snapshotId }, valid: true },
      },
    });

    const same = await fixture.execute<{
      rerunGraphAnalysis: { run: { algorithm: string; id: string } };
    }>({
      jar: owner.jar,
      query: `mutation($input: RerunGraphAnalysisInput!) {
        rerunGraphAnalysis(input: $input) { run { id algorithm } }
      }`,
      variables: { input: { snapshotId, algorithm: "DEGREE" } },
    });
    expect(same.body?.errors).toBeUndefined();
    expect(same.body?.data?.rerunGraphAnalysis.run.algorithm).toBe("DEGREE");

    const different = await fixture.execute<{
      rerunGraphAnalysis: { run: { algorithm: string; id: string } };
    }>({
      jar: owner.jar,
      query: `mutation($input: RerunGraphAnalysisInput!) {
        rerunGraphAnalysis(input: $input) { run { id algorithm } }
      }`,
      variables: { input: { snapshotId, algorithm: "PAGERANK" } },
    });
    expect(different.body?.errors).toBeUndefined();
    expect(different.body?.data?.rerunGraphAnalysis.run.algorithm).toBe(
      "PAGERANK",
    );

    for (const format of ["JSON", "CSV"] as const) {
      const exported = await fixture.execute<{
        graphAnalysisExport: {
          content: string;
          contentType: string;
          filename: string;
          resultCount: number;
          truncated: boolean;
        };
      }>({
        jar: owner.jar,
        query: `query($runId: UUID!, $format: GraphAnalysisExportFormat!) {
          graphAnalysisExport(runId: $runId, format: $format, first: 10) {
            content contentType filename resultCount truncated
          }
        }`,
        variables: {
          format,
          runId: different.body?.data?.rerunGraphAnalysis.run.id,
        },
      });
      expect(exported.body?.errors).toBeUndefined();
      expect(exported.body?.data?.graphAnalysisExport).toMatchObject({
        content: expect.any(String),
        contentType: expect.stringMatching(
          format === "JSON" ? /^application\/json/u : /^text\/csv/u,
        ),
        filename: expect.stringMatching(
          format === "JSON" ? /\.json$/u : /\.csv$/u,
        ),
        resultCount: 2,
        truncated: false,
      });
    }

    const corruptedRunId = different.body?.data?.rerunGraphAnalysis.run.id;
    if (!corruptedRunId) throw new Error("Analysis corruption fixture failed.");
    await fixture.connection`
      ALTER TABLE analysis_results DISABLE TRIGGER analysis_results_lifecycle_trigger
    `;
    try {
      await fixture.connection`
        UPDATE analysis_results SET payload_hash = ${"66".repeat(32)}
        WHERE analysis_run_id = ${corruptedRunId}
      `;
    } finally {
      await fixture.connection`
        ALTER TABLE analysis_results ENABLE TRIGGER analysis_results_lifecycle_trigger
      `;
    }
    expectGraphQLError(
      await fixture.execute({
        jar: owner.jar,
        query: `query($runId: UUID!) { graphAnalysisResults(runId: $runId, first: 10) { nodes { id } } }`,
        variables: { runId: corruptedRunId },
      }),
      "PRECONDITION_FAILED",
    );
    expectGraphQLError(
      await fixture.execute({
        jar: owner.jar,
        query: `query($runId: UUID!) { graphAnalysisExport(runId: $runId, format: JSON, first: 10) { content } }`,
        variables: { runId: corruptedRunId },
      }),
      "PRECONDITION_FAILED",
    );

    const beforeInvalidReplay = {
      runs: (await fixture.database.select().from(analysisRuns)).length,
      snapshots: (await fixture.database.select().from(graphSnapshots)).length,
    };
    await fixture.database
      .update(relationshipTypes)
      .set({ version: 2 })
      .where(eq(relationshipTypes.id, ids.type));
    const invalid = await fixture.execute({
      jar: owner.jar,
      query: `mutation($input: ReplayGraphSnapshotInput!) {
        replayGraphSnapshot(input: $input) { valid snapshot { id } }
      }`,
      variables: { input: { snapshotId } },
    });
    expect(invalid.body).toEqual({
      data: { replayGraphSnapshot: { snapshot: null, valid: false } },
    });
    expect(await fixture.database.select().from(analysisRuns)).toHaveLength(
      beforeInvalidReplay.runs,
    );
    expect(await fixture.database.select().from(graphSnapshots)).toHaveLength(
      beforeInvalidReplay.snapshots,
    );
  });

  it("invalidates additions, removals, policy drift, and actor drift without changed IDs", async () => {
    const owner = await seed();
    const createSnapshot = async () => {
      const result = await fixture.execute<{
        createGraphSnapshot: { id: string };
      }>({
        jar: owner.jar,
        query: `mutation($input: RunGraphAnalysisInput!) {
          createGraphSnapshot(input: $input) { id }
        }`,
        variables: {
          input: {
            algorithm: "DEGREE",
            filter: {
              mode: "WORKSPACE",
              nodeLimit: 10,
              edgeLimit: 10,
              includeIsolates: true,
            },
          },
        },
      });
      expect(result.body?.errors).toBeUndefined();
      return result.body?.data?.createGraphSnapshot.id;
    };
    const replaySnapshot = (jar: typeof owner.jar, snapshotId: string) =>
      fixture.execute({
        jar,
        query: `mutation($input: ReplayGraphSnapshotInput!) {
          replayGraphSnapshot(input: $input) { valid snapshot { id } }
        }`,
        variables: { input: { snapshotId } },
      });

    const beforeAddition = await createSnapshot();
    if (!beforeAddition) throw new Error("Snapshot fixture failed.");
    const addition = await fixture.createPerson(owner, {
      displayName: "Added after snapshot",
    });
    const additionId = addition.body?.data?.createPerson?.person?.id;
    if (!additionId) throw new Error("Addition fixture failed.");
    expect((await replaySnapshot(owner.jar, beforeAddition)).body).toEqual({
      data: { replayGraphSnapshot: { snapshot: null, valid: false } },
    });

    await fixture.database
      .update(people)
      .set({ deletedAt: new Date() })
      .where(eq(people.id, additionId));
    const beforeRemoval = await createSnapshot();
    if (!beforeRemoval) throw new Error("Snapshot fixture failed.");
    await fixture.database
      .update(people)
      .set({ deletedAt: new Date() })
      .where(eq(people.id, ids.target));
    const removed = await replaySnapshot(owner.jar, beforeRemoval);
    expect(removed.body).toEqual({
      data: { replayGraphSnapshot: { snapshot: null, valid: false } },
    });

    await fixture.database
      .update(people)
      .set({ deletedAt: null, sensitivity: "confidential" })
      .where(eq(people.id, ids.target));
    const policyId = newId();
    await fixture.database.insert(accessPolicies).values({
      id: policyId,
      workspaceId: owner.workspaceId,
      name: `Task 12 replay ${policyId}`,
      resourceKinds: ["person"],
      sensitivityCeiling: "restricted",
      state: "active",
      createdBy: owner.principalId,
      updatedBy: owner.principalId,
    });
    await fixture.database.insert(resourceGrants).values({
      id: newId(),
      workspaceId: owner.workspaceId,
      policyId,
      role: "owner",
      resourceId: ids.target,
      resourceKind: "person",
      state: "active",
      createdBy: owner.principalId,
      updatedBy: owner.principalId,
    });
    const beforePolicy = await createSnapshot();
    if (!beforePolicy) throw new Error("Snapshot fixture failed.");
    await fixture.database
      .update(accessPolicies)
      .set({ version: 2 })
      .where(eq(accessPolicies.id, policyId));
    expect((await replaySnapshot(owner.jar, beforePolicy)).body).toEqual({
      data: { replayGraphSnapshot: { snapshot: null, valid: false } },
    });

    await fixture.database
      .update(people)
      .set({ sensitivity: "internal" })
      .where(eq(people.id, ids.target));
    const beforeActor = await createSnapshot();
    if (!beforeActor) throw new Error("Snapshot fixture failed.");
    const analyst = await fixture.createWorkspaceMember(owner, "analyst");
    const actorDrift = await replaySnapshot(analyst.jar, beforeActor);
    expectGraphQLError(actorDrift, "NOT_FOUND");
    expect(actorDrift.body?.errors?.[0]?.message).toBe(
      "The graph snapshot was not found.",
    );
  });

  it("invalidates changed and deleted saved views with a generic audited result", async () => {
    const owner = await seed();
    const viewId = newId();
    const workspaceFilter = { mode: "WORKSPACE", nodeLimit: 10, edgeLimit: 10 };
    await fixture.database.insert(graphViews).values({
      id: viewId,
      workspaceId: owner.workspaceId,
      ownerId: owner.userId,
      name: "Replay drift contract",
      filters: workspaceFilter,
      sharing: "private",
      createdBy: owner.principalId,
      updatedBy: owner.principalId,
    });
    const createSnapshot = async () => {
      const result = await fixture.execute<{
        createGraphSnapshot: { id: string };
      }>({
        jar: owner.jar,
        query: `mutation($input: RunGraphAnalysisInput!) {
          createGraphSnapshot(input: $input) { id }
        }`,
        variables: { input: { algorithm: "DEGREE", graphViewId: viewId } },
      });
      expect(result.body?.errors).toBeUndefined();
      const id = result.body?.data?.createGraphSnapshot.id;
      if (!id) throw new Error("Snapshot fixture failed.");
      return id;
    };
    const replay = (snapshotId: string) =>
      fixture.execute({
        jar: owner.jar,
        query: `mutation($input: ReplayGraphSnapshotInput!) {
          replayGraphSnapshot(input: $input) { valid snapshot { id } }
        }`,
        variables: { input: { snapshotId } },
      });

    const changedViewSnapshot = await createSnapshot();
    await fixture.database
      .update(graphViews)
      .set({
        filters: {
          mode: "NEIGHBORHOOD",
          rootPersonIds: [ids.source],
          depth: 1,
          nodeLimit: 10,
          edgeLimit: 10,
        },
      })
      .where(eq(graphViews.id, viewId));
    expect((await replay(changedViewSnapshot)).body).toEqual({
      data: { replayGraphSnapshot: { snapshot: null, valid: false } },
    });

    await fixture.database
      .update(graphViews)
      .set({ filters: workspaceFilter })
      .where(eq(graphViews.id, viewId));
    const deletedViewSnapshot = await createSnapshot();
    await fixture.database
      .update(graphViews)
      .set({ deletedAt: new Date(), deletedBy: owner.principalId })
      .where(eq(graphViews.id, viewId));
    expect((await replay(deletedViewSnapshot)).body).toEqual({
      data: { replayGraphSnapshot: { snapshot: null, valid: false } },
    });

    const invalidationAudits = (
      await fixture.database.select().from(auditEvents)
    ).filter(
      ({ action, resourceId }) =>
        action === "graph_snapshot.invalidated" &&
        resourceId !== null &&
        [changedViewSnapshot, deletedViewSnapshot].includes(resourceId),
    );
    expect(invalidationAudits).toHaveLength(2);
    expect(
      invalidationAudits.every(
        ({ outcome, redactedDiff }) =>
          outcome === "success" &&
          (
            redactedDiff as { changedFields?: string[] }
          ).changedFields?.includes("validity") === true,
      ),
    ).toBe(true);
  });
});
