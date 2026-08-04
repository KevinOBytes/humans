// @vitest-environment node

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import {
  analysisResults,
  analysisRuns,
  graphSnapshots,
  personMetrics,
} from "@/db/schema/graph";
import { people } from "@/db/schema/people";
import { relationshipTypes, relationships } from "@/db/schema/relationships";
import {
  createGraphSnapshotManifest,
  graphSnapshotManifestMaterial,
  type GraphSnapshotManifestInput,
} from "@/modules/graph/snapshot-manifest";

import { ResearchFixture } from "../support/research-fixture";

const liveDescribe = process.env.TEST_DATABASE_URL ? describe : describe.skip;

const personIds = [
  "018f2100-0000-7000-8000-000000000001",
  "018f2100-0000-7000-8000-000000000002",
  "018f2100-0000-7000-8000-000000000003",
  "018f2100-0000-7000-8000-000000000004",
] as const;
const relationshipTypeId = "018f2100-0000-7000-8000-000000000101";
const relationshipIds = [
  "018f2100-0000-7000-8000-000000000201",
  "018f2100-0000-7000-8000-000000000202",
  "018f2100-0000-7000-8000-000000000203",
  "018f2100-0000-7000-8000-000000000204",
  "018f2100-0000-7000-8000-000000000205",
] as const;

const privateMarker = "private-biography-must-not-leak";
const unsafeDisplayName = '=HYPERLINK("https://example.invalid","private")';

const matrix = [
  {
    algorithm: "DEGREE",
    configuration: { projection: "authorized-visible-incidence-v1" },
    explanation:
      "Visible relationship incidence count in this authorized snapshot.",
    expected: [
      { personId: personIds[0], rank: 2, value: 2 },
      { personId: personIds[1], rank: 3, value: 2 },
      { personId: personIds[2], rank: 1, value: 4 },
      { personId: personIds[3], rank: 4, value: 2 },
    ],
    metricKey: "degree",
    version: "graphology@0.26.0/degree/humans-v1",
  },
  {
    algorithm: "PAGERANK",
    configuration: {
      alpha: 0.85,
      maxIterations: 200,
      projection: "authorized-directed-aggregate-count-v1",
      tolerance: 1e-8,
      weight: "relationship-count",
    },
    explanation:
      "PageRank over this authorized snapshot using relationship direction, alpha 0.85, tolerance 1e-8, and at most 200 iterations.",
    expected: [
      { personId: personIds[0], rank: 4, value: 0.0375 },
      { personId: personIds[1], rank: 3, value: 0.0534375 },
      { personId: personIds[2], rank: 1, value: 0.4711148734056677 },
      { personId: personIds[3], rank: 2, value: 0.4379476265943322 },
    ],
    metricKey: "pagerank",
    version: "graphology-metrics@2.4.0/pagerank/humans-v2",
  },
  {
    algorithm: "LOUVAIN_COMMUNITY",
    configuration: {
      fastLocalMoves: true,
      projection: "authorized-undirected-aggregate-count-v1",
      randomWalk: true,
      resolution: 1,
      seed: "graph-fingerprint-fnv1a32-v1",
      weight: "relationship-count",
    },
    explanation:
      "Community label in a seeded undirected simple projection; parallel visible relationships are aggregated by count.",
    expected: [
      { personId: personIds[0], rank: 3, value: 1 },
      { personId: personIds[1], rank: 4, value: 1 },
      { personId: personIds[2], rank: 1, value: 2 },
      { personId: personIds[3], rank: 2, value: 2 },
    ],
    metricKey: "community",
    version: "graphology-communities-louvain@2.0.2/humans-undirected-v1",
  },
] as const;

type Metric = {
  algorithmVersion: string;
  explanation: string;
  metricKey: string;
  personId: string;
  rank: number;
  value: number;
};

type Result = {
  explanation: string | null;
  id: string;
  rank: number | null;
  resultKind: string;
  subjectPersonId: string | null;
  value: number;
};

liveDescribe("graph algorithm live matrix", () => {
  let fixture: ResearchFixture;

  beforeAll(() => {
    fixture = new ResearchFixture();
  });
  beforeEach(async () => fixture.reset());
  afterAll(async () => fixture.close());

  async function seed() {
    const owner = await fixture.createActor();
    await fixture.database.insert(people).values(
      personIds.map((id, index) => ({
        id,
        workspaceId: owner.workspaceId,
        displayName: index === 0 ? unsafeDisplayName : `Matrix Person ${index}`,
        sortName: `Matrix Person ${index}`,
        biography: index === 0 ? privateMarker : null,
        sensitivity: "internal" as const,
        createdBy: owner.principalId,
        updatedBy: owner.principalId,
      })),
    );
    await fixture.database.insert(relationshipTypes).values({
      id: relationshipTypeId,
      workspaceId: owner.workspaceId,
      key: "matrix_knows",
      forwardLabel: "knows",
      inverseLabel: "known by",
      directed: true,
      createdBy: owner.principalId,
      updatedBy: owner.principalId,
    });
    const endpoints = [
      [personIds[0], personIds[1]],
      [personIds[0], personIds[2]],
      [personIds[1], personIds[2]],
      [personIds[2], personIds[3]],
      [personIds[3], personIds[2]],
    ] as const;
    await fixture.database.insert(relationships).values(
      endpoints.map(([sourcePersonId, targetPersonId], index) => ({
        id: relationshipIds[index]!,
        workspaceId: owner.workspaceId,
        sourcePersonId,
        targetPersonId,
        relationshipTypeId,
        sensitivity: "internal" as const,
        createdBy: owner.principalId,
        updatedBy: owner.principalId,
      })),
    );
    return owner;
  }

  async function readAllResults(
    jar: Awaited<ReturnType<typeof seed>>["jar"],
    runId: string,
  ) {
    const first = await fixture.execute<{
      graphAnalysisResults: {
        nodes: Result[];
        pageInfo: { endCursor: string | null; hasNextPage: boolean };
      };
    }>({
      jar,
      query: `query($runId: UUID!) {
        graphAnalysisResults(runId: $runId, first: 2) {
          nodes { id resultKind subjectPersonId value rank explanation }
          pageInfo { endCursor hasNextPage }
        }
      }`,
      variables: { runId },
    });
    expect(first.body?.errors).toBeUndefined();
    expect(first.body?.data?.graphAnalysisResults.pageInfo).toEqual({
      endCursor: expect.any(String),
      hasNextPage: true,
    });

    const second = await fixture.execute<{
      graphAnalysisResults: {
        nodes: Result[];
        pageInfo: { endCursor: string | null; hasNextPage: boolean };
      };
    }>({
      jar,
      query: `query($runId: UUID!, $after: String!) {
        graphAnalysisResults(runId: $runId, first: 2, after: $after) {
          nodes { id resultKind subjectPersonId value rank explanation }
          pageInfo { endCursor hasNextPage }
        }
      }`,
      variables: {
        after: first.body?.data?.graphAnalysisResults.pageInfo.endCursor,
        runId,
      },
    });
    expect(second.body?.errors).toBeUndefined();
    expect(second.body?.data?.graphAnalysisResults.pageInfo).toEqual({
      endCursor: expect.any(String),
      hasNextPage: false,
    });
    const pages = [
      ...(first.body?.data?.graphAnalysisResults.nodes ?? []),
      ...(second.body?.data?.graphAnalysisResults.nodes ?? []),
    ];
    expect(pages).toHaveLength(personIds.length);
    expect(new Set(pages.map(({ id }) => id))).toHaveLength(personIds.length);
    return pages;
  }

  async function exportResults(
    jar: Awaited<ReturnType<typeof seed>>["jar"],
    runId: string,
    format: "CSV" | "JSON",
  ) {
    const response = await fixture.execute<{
      graphAnalysisExport: {
        content: string;
        contentType: string;
        filename: string;
        resultCount: number;
        truncated: boolean;
      };
    }>({
      jar,
      query: `query($runId: UUID!, $format: GraphAnalysisExportFormat!) {
        graphAnalysisExport(runId: $runId, format: $format, first: 10) {
          content contentType filename resultCount truncated
        }
      }`,
      variables: { format, runId },
    });
    expect(response.body?.errors).toBeUndefined();
    const exported = response.body?.data?.graphAnalysisExport;
    expect(exported).toMatchObject({
      content: expect.any(String),
      contentType: expect.stringMatching(
        format === "JSON" ? /^application\/json/u : /^text\/csv/u,
      ),
      filename: expect.stringMatching(
        format === "JSON" ? /\.json$/u : /\.csv$/u,
      ),
      resultCount: personIds.length,
      truncated: false,
    });
    if (!exported) throw new Error("Graph export fixture failed.");
    expect(exported.content).not.toContain(privateMarker);
    expect(exported.content).not.toContain(unsafeDisplayName);
    return exported.content;
  }

  it("replays a shipped PageRank v1 snapshot and reruns it with the current bounded contract", async () => {
    const owner = await seed();
    const created = await fixture.execute<{
      createGraphSnapshot: { id: string };
    }>({
      jar: owner.jar,
      query: `mutation($input: RunGraphAnalysisInput!) {
        createGraphSnapshot(input: $input) { id }
      }`,
      variables: {
        input: {
          algorithm: "PAGERANK",
          filter: {
            mode: "WORKSPACE",
            nodeLimit: 10,
            edgeLimit: 10,
            includeIsolates: true,
          },
        },
      },
    });
    expect(created.body?.errors).toBeUndefined();
    const snapshotId = created.body?.data?.createGraphSnapshot.id;
    if (!snapshotId) throw new Error("Historical snapshot fixture failed.");
    const [stored] = await fixture.database
      .select()
      .from(graphSnapshots)
      .where(eq(graphSnapshots.id, snapshotId));
    if (!stored) throw new Error("Historical snapshot row was not persisted.");

    const configuration = {
      alpha: 0.85,
      maxIterations: 100,
      projection: "authorized-directed-aggregate-count-v1",
      tolerance: 1e-8,
      weight: "relationship-count",
    } as const;
    const algorithmVersion = "graphology-metrics@2.4.0/pagerank/humans-v1";
    const historical = createGraphSnapshotManifest({
      ...(stored.manifestMaterial as GraphSnapshotManifestInput),
      algorithmConfiguration: configuration,
      algorithmVersion,
    });
    await fixture.connection`
      ALTER TABLE graph_snapshots
      DISABLE TRIGGER graph_snapshots_immutable_trigger
    `;
    try {
      await fixture.connection`
        UPDATE graph_snapshots SET
          algorithm_version = ${algorithmVersion},
          algorithm_config_hash = ${historical.algorithmConfigHash},
          algorithm_configuration = ${JSON.stringify(configuration)}::jsonb,
          manifest_hash = ${historical.manifestHash},
          manifest_material = ${JSON.stringify(
            graphSnapshotManifestMaterial(historical),
          )}::jsonb
        WHERE id = ${snapshotId}
      `;
    } finally {
      await fixture.connection`
        ALTER TABLE graph_snapshots
        ENABLE TRIGGER graph_snapshots_immutable_trigger
      `;
    }

    const replay = await fixture.execute<{
      replayGraphSnapshot: { snapshot: { id: string }; valid: boolean };
    }>({
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

    const rerun = await fixture.execute<{
      rerunGraphAnalysis: { metrics: Metric[]; run: { id: string } };
    }>({
      jar: owner.jar,
      query: `mutation($input: RerunGraphAnalysisInput!) {
        rerunGraphAnalysis(input: $input) {
          run { id }
          metrics { personId metricKey value rank algorithmVersion explanation }
        }
      }`,
      variables: { input: { algorithm: "PAGERANK", snapshotId } },
    });
    expect(rerun.body?.errors).toBeUndefined();
    const rerunPayload = rerun.body?.data?.rerunGraphAnalysis;
    expect(rerunPayload?.metrics).toHaveLength(personIds.length);
    expect(
      rerunPayload?.metrics.every(
        ({ algorithmVersion: version }) =>
          version === "graphology-metrics@2.4.0/pagerank/humans-v2",
      ),
    ).toBe(true);
    const currentRun = rerunPayload?.run.id
      ? await fixture.database
          .select()
          .from(analysisRuns)
          .where(eq(analysisRuns.id, rerunPayload.run.id))
      : [];
    expect(currentRun).toEqual([
      expect.objectContaining({
        algorithm: "PAGERANK",
        algorithmVersion: "graphology-metrics@2.4.0/pagerank/humans-v2",
        state: "completed",
      }),
    ]);
  });

  it.each(matrix)(
    "persists, pages, replays, repeats, and safely exports $algorithm",
    async ({
      algorithm,
      configuration,
      explanation,
      expected,
      metricKey,
      version,
    }) => {
      const owner = await seed();
      const created = await fixture.execute<{
        runGraphAnalysis: {
          metrics: Metric[];
          run: {
            algorithm: string;
            graphSnapshotId: string;
            id: string;
            state: string;
          };
        };
      }>({
        jar: owner.jar,
        query: `mutation($input: RunGraphAnalysisInput!) {
          runGraphAnalysis(input: $input) {
            run { id graphSnapshotId state algorithm }
            metrics { personId metricKey value rank algorithmVersion explanation }
          }
        }`,
        variables: {
          input: {
            algorithm,
            filter: {
              mode: "WORKSPACE",
              nodeLimit: 10,
              edgeLimit: 10,
              includeIsolates: true,
            },
          },
        },
      });
      expect(created.body?.errors).toBeUndefined();
      const payload = created.body?.data?.runGraphAnalysis;
      expect(payload?.run).toMatchObject({ algorithm, state: "completed" });
      expect(payload?.metrics).toHaveLength(personIds.length);
      expect(payload?.metrics).toEqual(
        expect.arrayContaining(
          personIds.map((personId) =>
            expect.objectContaining({
              algorithmVersion: version,
              explanation,
              metricKey,
              personId,
              rank: expect.any(Number),
              value: expect.any(Number),
            }),
          ),
        ),
      );
      expect(
        payload?.metrics.every(
          ({ rank, value }) =>
            Number.isInteger(rank) && rank > 0 && Number.isFinite(value),
        ),
      ).toBe(true);
      if (!payload) throw new Error("Graph algorithm fixture failed.");
      for (const semantic of expected) {
        const metric = payload.metrics.find(
          ({ personId }) => personId === semantic.personId,
        );
        expect(metric?.rank).toBe(semantic.rank);
        expect(metric?.value).toBeCloseTo(semantic.value, 12);
      }

      const [storedRun] = await fixture.database
        .select()
        .from(analysisRuns)
        .where(eq(analysisRuns.id, payload.run.id));
      const [storedSnapshot] = await fixture.database
        .select()
        .from(graphSnapshots)
        .where(eq(graphSnapshots.id, payload.run.graphSnapshotId));
      expect(storedRun).toMatchObject({
        algorithm,
        algorithmVersion: version,
        configuration,
        configurationHash: expect.stringMatching(/^[0-9a-f]{64}$/u),
        state: "completed",
      });
      expect(storedSnapshot).toMatchObject({
        algorithm,
        algorithmConfiguration: configuration,
        algorithmVersion: version,
        algorithmConfigHash: storedRun?.configurationHash,
        manifestSchema: "humans.graph-snapshot-manifest.v1",
      });
      const storedResults = await fixture.database
        .select()
        .from(analysisResults)
        .where(eq(analysisResults.analysisRunId, payload.run.id));
      expect(storedResults).toHaveLength(personIds.length);
      expect(storedResults).toEqual(
        expect.arrayContaining(
          personIds.map((subjectPersonId) =>
            expect.objectContaining({
              explanation,
              numericValue: expect.any(String),
              payloadHash: expect.stringMatching(/^[0-9a-f]{64}$/u),
              payloadSchema: "humans.graph-analysis-result.v1",
              rank: expect.any(Number),
              resultKind: metricKey,
              subjectPersonId,
            }),
          ),
        ),
      );
      expect(
        await fixture.database
          .select()
          .from(personMetrics)
          .where(
            eq(personMetrics.graphSnapshotId, payload.run.graphSnapshotId),
          ),
      ).toEqual(
        expect.arrayContaining(
          personIds.map((personId) =>
            expect.objectContaining({
              algorithmVersion: version,
              metricKey,
              personId,
              rank: expect.any(Number),
            }),
          ),
        ),
      );

      const originalResults = await readAllResults(owner.jar, payload.run.id);
      expect(originalResults.map(({ rank }) => rank)).toEqual(
        [...originalResults]
          .map(({ rank }) => rank)
          .sort((left, right) => (left ?? 0) - (right ?? 0)),
      );
      expect(originalResults).toEqual(
        expect.arrayContaining(
          personIds.map((subjectPersonId) =>
            expect.objectContaining({
              explanation,
              rank: expect.any(Number),
              resultKind: metricKey,
              subjectPersonId,
              value: expect.any(Number),
            }),
          ),
        ),
      );

      const snapshot = await fixture.execute<{
        graphSnapshot: {
          algorithm: string;
          algorithmConfigHash: string;
          algorithmVersion: string;
          id: string;
          manifestHash: string;
          manifestSchema: string;
        };
      }>({
        jar: owner.jar,
        query: `query($id: UUID!) {
          graphSnapshot(id: $id) {
            id manifestSchema manifestHash algorithm algorithmVersion algorithmConfigHash
          }
        }`,
        variables: { id: payload.run.graphSnapshotId },
      });
      expect(snapshot.body?.errors).toBeUndefined();
      expect(snapshot.body?.data?.graphSnapshot).toMatchObject({
        algorithm,
        algorithmConfigHash: storedRun?.configurationHash,
        algorithmVersion: version,
        id: payload.run.graphSnapshotId,
        manifestHash: expect.stringMatching(/^[0-9a-f]{64}$/u),
        manifestSchema: "humans.graph-snapshot-manifest.v1",
      });

      const replay = await fixture.execute<{
        replayGraphSnapshot: { snapshot: { id: string }; valid: boolean };
      }>({
        jar: owner.jar,
        query: `mutation($input: ReplayGraphSnapshotInput!) {
          replayGraphSnapshot(input: $input) { valid snapshot { id } }
        }`,
        variables: { input: { snapshotId: payload.run.graphSnapshotId } },
      });
      expect(replay.body).toEqual({
        data: {
          replayGraphSnapshot: {
            snapshot: { id: payload.run.graphSnapshotId },
            valid: true,
          },
        },
      });

      const repeated = await fixture.execute<{
        rerunGraphAnalysis: { metrics: Metric[]; run: { id: string } };
      }>({
        jar: owner.jar,
        query: `mutation($input: RerunGraphAnalysisInput!) {
          rerunGraphAnalysis(input: $input) {
            run { id }
            metrics { personId metricKey value rank algorithmVersion explanation }
          }
        }`,
        variables: {
          input: { snapshotId: payload.run.graphSnapshotId, algorithm },
        },
      });
      expect(repeated.body?.errors).toBeUndefined();
      expect(repeated.body?.data?.rerunGraphAnalysis.metrics).toEqual(
        payload.metrics,
      );
      const repeatedRunId = repeated.body?.data?.rerunGraphAnalysis.run.id;
      if (!repeatedRunId) throw new Error("Graph rerun fixture failed.");
      const repeatedResults = await readAllResults(owner.jar, repeatedRunId);
      const semantic = (results: Result[]) =>
        results.map(
          ({ explanation: why, rank, resultKind, subjectPersonId, value }) => ({
            explanation: why,
            rank,
            resultKind,
            subjectPersonId,
            value,
          }),
        );
      expect(semantic(repeatedResults)).toEqual(semantic(originalResults));

      const originalJson = await exportResults(
        owner.jar,
        payload.run.id,
        "JSON",
      );
      const repeatedJson = await exportResults(
        owner.jar,
        repeatedRunId,
        "JSON",
      );
      expect(repeatedJson).toBe(originalJson);
      const parsed = JSON.parse(originalJson) as Record<string, unknown>;
      expect(parsed).toMatchObject({
        algorithm,
        algorithmVersion: version,
        configurationHash: storedRun?.configurationHash,
        schema: "humans.graph-analysis-export.v1",
        truncated: false,
      });
      expect(Object.keys(parsed).sort()).toEqual([
        "algorithm",
        "algorithmVersion",
        "configurationHash",
        "results",
        "schema",
        "truncated",
      ]);
      const jsonResults = parsed.results as Array<Record<string, unknown>>;
      expect(jsonResults).toHaveLength(personIds.length);
      expect(
        jsonResults.every(
          (result) =>
            JSON.stringify(Object.keys(result).sort()) ===
            JSON.stringify([
              "explanation",
              "rank",
              "resultKind",
              "subjectPersonId",
              "value",
            ]),
        ),
      ).toBe(true);

      const originalCsv = await exportResults(owner.jar, payload.run.id, "CSV");
      const repeatedCsv = await exportResults(owner.jar, repeatedRunId, "CSV");
      expect(repeatedCsv).toBe(originalCsv);
      expect(originalCsv).toMatch(
        /^result_kind,subject_person_id,value,rank,explanation\r\n/u,
      );
      expect(originalCsv).not.toMatch(/(?:^|[,\r\n])\s*[-=+@]/u);
    },
    30_000,
  );
});
