// @vitest-environment node

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import { newId } from "@/db/id";
import { relationshipTypes, relationships } from "@/db/schema/relationships";
import { workspaceSettings } from "@/db/schema/workspaces";
import {
  CreateGraphSnapshotDocument,
  DashboardOverviewDocument,
  GraphAnalysisExportDocument,
  GraphAnalysisResultsDocument,
  GraphAnalysisRunsDocument,
  ReplayGraphSnapshotDocument,
  RerunGraphAnalysisDocument,
  RunGraphAnalysisDocument,
  StartAiAnalysisDocument,
} from "@/graphql/generated/graphql";

import {
  expectGraphQLError,
  type OperationResult,
  type SessionActor,
} from "../support/graphql";
import { ResearchFixture } from "../support/research-fixture";

const liveDescribe = process.env.TEST_DATABASE_URL ? describe : describe.skip;

function dataField<T>(
  result: OperationResult<Record<string, T>>,
  field: string,
): T {
  expect(result.body?.errors).toBeUndefined();
  const value = result.body?.data?.[field];
  if (value == null) throw new Error(`Missing GraphQL field ${field}`);
  return value;
}

liveDescribe(
  "generated dashboard and graph-analysis product operations",
  () => {
    let fixture: ResearchFixture;

    beforeAll(() => {
      fixture = new ResearchFixture();
    });
    beforeEach(async () => fixture.reset());
    afterAll(async () => fixture.close());

    async function seedGraph(owner: SessionActor) {
      const personIds: string[] = [];
      for (const displayName of [
        "Generated Graph Alpha",
        "Generated Graph Beta",
        "Generated Graph Gamma",
        "Generated Graph Delta",
      ]) {
        const created = await fixture.createPerson(owner, { displayName });
        expect(created.body?.errors).toBeUndefined();
        const id = created.body?.data?.createPerson?.person?.id;
        if (!id) throw new Error("Generated graph person fixture failed.");
        personIds.push(id);
      }
      const relationshipTypeId = newId();
      await fixture.database.insert(relationshipTypes).values({
        id: relationshipTypeId,
        workspaceId: owner.workspaceId,
        key: `generated_graph_${relationshipTypeId}`,
        forwardLabel: "links to",
        inverseLabel: "linked from",
        directed: true,
        createdBy: owner.principalId,
        updatedBy: owner.principalId,
      });
      const endpoints = [
        [0, 1],
        [0, 2],
        [1, 2],
        [2, 3],
        [3, 2],
      ] as const;
      await fixture.database.insert(relationships).values(
        endpoints.map(([source, target]) => ({
          id: newId(),
          workspaceId: owner.workspaceId,
          sourcePersonId: personIds[source]!,
          targetPersonId: personIds[target]!,
          relationshipTypeId,
          sensitivity: "internal" as const,
          createdBy: owner.principalId,
          updatedBy: owner.principalId,
        })),
      );
      return personIds;
    }

    const boundedFilter = {
      edgeLimit: 10,
      includeIsolates: true,
      mode: "WORKSPACE" as const,
      nodeLimit: 10,
    };

    it("reads the composed owner and viewer dashboards through the generated document", async () => {
      const owner = await fixture.createActor();
      const people = await seedGraph(owner);
      const foreign = await fixture.createActor();
      await fixture.createPerson(foreign, {
        displayName: "Foreign dashboard marker must not leak",
      });
      await fixture.database
        .update(workspaceSettings)
        .set({ retentionDays: 45, aiEnabled: true, storageEnabled: false })
        .where(eq(workspaceSettings.workspaceId, owner.workspaceId));

      const graphRun = dataField<{
        run: { id: string; state: string };
      }>(
        await fixture.execute({
          jar: owner.jar,
          operationName: "RunGraphAnalysis",
          query: RunGraphAnalysisDocument,
          variables: {
            input: { algorithm: "DEGREE", filter: boundedFilter },
          },
        }),
        "runGraphAnalysis",
      );
      const aiRun = dataField<{ id: string; model: string; provider: string }>(
        await fixture.execute({
          jar: owner.jar,
          operationName: "StartAiAnalysis",
          query: StartAiAnalysisDocument,
          variables: {
            input: {
              idempotencyKey: `dashboard-${newId()}`,
              question: "Summarize this generated dashboard fixture.",
            },
          },
        }),
        "startAiAnalysis",
      );

      const ownerResponse = await fixture.execute<{
        auditEvents: { nodes: Array<{ action: string }> };
        dashboardRecentAiAnalyses: { nodes: Array<{ id: string }> };
        dashboardRecentGraphAnalyses: { nodes: Array<{ id: string }> };
        dashboardRecentPeople: { nodes: Array<{ id: string }> };
        graphStatistics: {
          visiblePeople: number;
          visibleRelationships: number;
        };
        imports: { nodes: unknown[] };
        workspacePolicySummary: {
          aiEnabled: boolean;
          defaultRetentionDays: number;
          storageEnabled: boolean;
        };
      }>({
        jar: owner.jar,
        operationName: "DashboardOverview",
        query: DashboardOverviewDocument,
        variables: { includeActivity: true },
      });
      expect(ownerResponse.body?.errors).toBeUndefined();
      expect(
        ownerResponse.body?.data?.dashboardRecentPeople.nodes.map(
          ({ id }) => id,
        ),
      ).toEqual(expect.arrayContaining(people));
      expect(ownerResponse.body?.data).toMatchObject({
        dashboardRecentAiAnalyses: {
          nodes: [expect.objectContaining({ id: aiRun.id })],
        },
        dashboardRecentGraphAnalyses: {
          nodes: [expect.objectContaining({ id: graphRun.run.id })],
        },
        graphStatistics: { visiblePeople: 4, visibleRelationships: 5 },
        imports: { nodes: [] },
        workspacePolicySummary: {
          aiEnabled: true,
          defaultRetentionDays: 45,
          storageEnabled: false,
        },
      });
      expect(
        ownerResponse.body?.data?.auditEvents.nodes.length,
      ).toBeGreaterThan(0);
      expect(JSON.stringify(ownerResponse.body)).not.toContain(
        "Foreign dashboard marker must not leak",
      );

      const viewer = await fixture.createWorkspaceMember(owner, "viewer");
      const viewerResponse = await fixture.execute<{
        auditEvents?: unknown;
        dashboardRecentAiAnalyses: { nodes: Array<{ id: string }> };
        dashboardRecentPeople: { nodes: Array<{ id: string }> };
        graphStatistics: {
          visiblePeople: number;
          visibleRelationships: number;
        };
      }>({
        jar: viewer.jar,
        operationName: "DashboardOverview",
        query: DashboardOverviewDocument,
        variables: { includeActivity: false },
      });
      expect(viewerResponse.body?.errors).toBeUndefined();
      expect(
        viewerResponse.body?.data?.dashboardRecentPeople.nodes,
      ).toHaveLength(4);
      expect(viewerResponse.body?.data?.graphStatistics).toEqual({
        visiblePeople: 4,
        visibleRelationships: 5,
      });
      expect(
        viewerResponse.body?.data?.dashboardRecentAiAnalyses.nodes,
      ).toEqual([]);
      expect(
        Object.hasOwn(viewerResponse.body?.data ?? {}, "auditEvents"),
      ).toBe(false);
      expectGraphQLError(
        await fixture.execute({
          jar: viewer.jar,
          operationName: "DashboardOverview",
          query: DashboardOverviewDocument,
          variables: { includeActivity: true },
        }),
        "FORBIDDEN",
      );
    });

    it("executes all generated graph-analysis documents with readbacks and safe denials", async () => {
      const owner = await fixture.createActor();
      await seedGraph(owner);
      const viewer = await fixture.createWorkspaceMember(owner, "viewer");
      const foreign = await fixture.createActor();

      const created = dataField<{
        graph: { fingerprint: string; nodes: unknown[] };
        metrics: Array<{
          algorithmVersion: string;
          metricKey: string;
          personId: string;
          rank: number;
          value: number;
        }>;
        run: {
          algorithm: string;
          graphSnapshotId: string;
          id: string;
          state: string;
        };
      }>(
        await fixture.execute({
          jar: owner.jar,
          operationName: "RunGraphAnalysis",
          query: RunGraphAnalysisDocument,
          variables: {
            input: { algorithm: "DEGREE", filter: boundedFilter },
          },
        }),
        "runGraphAnalysis",
      );
      expect(created.run).toMatchObject({
        algorithm: "DEGREE",
        state: "completed",
      });
      expect(created.metrics).toHaveLength(4);
      expect(created.graph).toMatchObject({
        fingerprint: expect.stringMatching(/^[0-9a-f]{64}$/u),
        nodes: expect.any(Array),
      });

      const runs = dataField<{
        nodes: Array<{ id: string }>;
        pageInfo: { endCursor: string | null; hasNextPage: boolean };
      }>(
        await fixture.execute({
          jar: owner.jar,
          operationName: "GraphAnalysisRuns",
          query: GraphAnalysisRunsDocument,
          variables: { first: 10 },
        }),
        "graphAnalysisRuns",
      );
      expect(runs.nodes).toEqual([
        expect.objectContaining({ id: created.run.id }),
      ]);

      const firstResults = dataField<{
        nodes: Array<{
          analysisRunId: string;
          id: string;
          rank: number;
          resultKind: string;
          subjectPersonId: string;
          value: number;
        }>;
        pageInfo: { endCursor: string | null; hasNextPage: boolean };
      }>(
        await fixture.execute({
          jar: owner.jar,
          operationName: "GraphAnalysisResults",
          query: GraphAnalysisResultsDocument,
          variables: { runId: created.run.id, first: 2 },
        }),
        "graphAnalysisResults",
      );
      expect(firstResults.nodes).toHaveLength(2);
      expect(firstResults.pageInfo).toEqual({
        endCursor: expect.any(String),
        hasNextPage: true,
      });
      const secondResults = dataField<{
        nodes: Array<{ id: string }>;
        pageInfo: { hasNextPage: boolean };
      }>(
        await fixture.execute({
          jar: owner.jar,
          operationName: "GraphAnalysisResults",
          query: GraphAnalysisResultsDocument,
          variables: {
            runId: created.run.id,
            first: 2,
            after: firstResults.pageInfo.endCursor,
          },
        }),
        "graphAnalysisResults",
      );
      expect(secondResults.nodes).toHaveLength(2);
      expect(secondResults.pageInfo.hasNextPage).toBe(false);
      expect(
        new Set([
          ...firstResults.nodes.map(({ id }) => id),
          ...secondResults.nodes.map(({ id }) => id),
        ]),
      ).toHaveLength(4);

      for (const format of ["JSON", "CSV"] as const) {
        const exported = dataField<{
          content: string;
          contentType: string;
          filename: string;
          format: string;
          resultCount: number;
          truncated: boolean;
        }>(
          await fixture.execute({
            jar: owner.jar,
            operationName: "GraphAnalysisExport",
            query: GraphAnalysisExportDocument,
            variables: { runId: created.run.id, format, first: 10 },
          }),
          "graphAnalysisExport",
        );
        expect(exported).toMatchObject({
          format,
          resultCount: 4,
          truncated: false,
        });
        expect(exported.content).not.toContain("Generated Graph Alpha");
        if (format === "JSON") {
          expect(JSON.parse(exported.content)).toMatchObject({
            algorithm: "DEGREE",
            results: expect.any(Array),
            schema: "humans.graph-analysis-export.v1",
          });
        } else {
          expect(exported.content).toMatch(
            /^result_kind,subject_person_id,value,rank,explanation\r\n/u,
          );
        }
      }

      const rerun = dataField<{
        metrics: Array<{ algorithmVersion: string; metricKey: string }>;
        run: { algorithm: string; id: string; state: string };
      }>(
        await fixture.execute({
          jar: owner.jar,
          operationName: "RerunGraphAnalysis",
          query: RerunGraphAnalysisDocument,
          variables: {
            input: {
              algorithm: "PAGERANK",
              snapshotId: created.run.graphSnapshotId,
            },
          },
        }),
        "rerunGraphAnalysis",
      );
      expect(rerun.run).toMatchObject({
        algorithm: "PAGERANK",
        state: "completed",
      });
      expect(
        rerun.metrics.every(
          ({ algorithmVersion, metricKey }) =>
            metricKey === "pagerank" &&
            algorithmVersion === "graphology-metrics@2.4.0/pagerank/humans-v2",
        ),
      ).toBe(true);

      const snapshot = dataField<{
        algorithm: string;
        algorithmVersion: string;
        id: string;
        manifestHash: string;
      }>(
        await fixture.execute({
          jar: owner.jar,
          operationName: "CreateGraphSnapshot",
          query: CreateGraphSnapshotDocument,
          variables: {
            input: { algorithm: "LOUVAIN_COMMUNITY", filter: boundedFilter },
          },
        }),
        "createGraphSnapshot",
      );
      expect(snapshot).toMatchObject({
        algorithm: "LOUVAIN_COMMUNITY",
        algorithmVersion:
          "graphology-communities-louvain@2.0.2/humans-undirected-v1",
        manifestHash: expect.stringMatching(/^[0-9a-f]{64}$/u),
      });
      const replay = dataField<{
        snapshot: { id: string };
        valid: boolean;
      }>(
        await fixture.execute({
          jar: owner.jar,
          operationName: "ReplayGraphSnapshot",
          query: ReplayGraphSnapshotDocument,
          variables: { input: { snapshotId: snapshot.id } },
        }),
        "replayGraphSnapshot",
      );
      expect(replay).toMatchObject({
        snapshot: { id: snapshot.id },
        valid: true,
      });

      expectGraphQLError(
        await fixture.execute({
          jar: viewer.jar,
          operationName: "RunGraphAnalysis",
          query: RunGraphAnalysisDocument,
          variables: {
            input: { algorithm: "DEGREE", filter: boundedFilter },
          },
        }),
        "FORBIDDEN",
      );
      expectGraphQLError(
        await fixture.execute({
          jar: viewer.jar,
          operationName: "ReplayGraphSnapshot",
          query: ReplayGraphSnapshotDocument,
          variables: { input: { snapshotId: snapshot.id } },
        }),
        "FORBIDDEN",
      );
      for (const query of [
        fixture.execute({
          jar: foreign.jar,
          operationName: "GraphAnalysisResults",
          query: GraphAnalysisResultsDocument,
          variables: { runId: created.run.id, first: 1 },
        }),
        fixture.execute({
          jar: foreign.jar,
          operationName: "GraphAnalysisExport",
          query: GraphAnalysisExportDocument,
          variables: { runId: created.run.id, format: "JSON", first: 10 },
        }),
      ]) {
        expectGraphQLError(await query, "NOT_FOUND");
      }
      expectGraphQLError(
        await fixture.execute({
          jar: owner.jar,
          operationName: "GraphAnalysisRuns",
          query: GraphAnalysisRunsDocument,
          variables: { first: 0 },
        }),
        "VALIDATION_FAILED",
      );
      const cursor = firstResults.pageInfo.endCursor;
      if (!cursor) throw new Error("Generated result cursor fixture failed.");
      const tampered = `${cursor.slice(0, -1)}${cursor.endsWith("a") ? "b" : "a"}`;
      expectGraphQLError(
        await fixture.execute({
          jar: owner.jar,
          operationName: "GraphAnalysisResults",
          query: GraphAnalysisResultsDocument,
          variables: { runId: created.run.id, first: 2, after: tampered },
        }),
        "VALIDATION_FAILED",
      );
    });
  },
);
