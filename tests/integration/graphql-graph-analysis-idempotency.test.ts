// @vitest-environment node

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";

import { newId } from "@/db/id";
import {
  analysisResults,
  analysisRuns,
  graphSnapshots,
  personMetrics,
} from "@/db/schema/graph";
import { locationMutationIdempotency } from "@/db/schema/locations";
import { auditEvents } from "@/db/schema/operations";
import { people } from "@/db/schema/people";
import { relationshipTypes, relationships } from "@/db/schema/relationships";
import {
  CreateGraphSnapshotDocument,
  ReplayGraphSnapshotDocument,
  RerunGraphAnalysisDocument,
  RunGraphAnalysisDocument,
} from "@/graphql/generated/graphql";

import { expectGraphQLError } from "../support/graphql";
import { ResearchFixture } from "../support/research-fixture";

const liveDescribe = process.env.TEST_DATABASE_URL ? describe : describe.skip;

function required<T>(value: T | null | undefined, label: string): T {
  if (value == null) throw new Error(`Missing ${label}`);
  return value;
}

liveDescribe("graph analysis mutation idempotency", () => {
  let fixture: ResearchFixture;

  beforeAll(() => {
    fixture = new ResearchFixture({
      searchRuntime: {
        cursorHmacKey: "45".repeat(32),
        protectedLookupHmacKey: "43".repeat(32),
      },
    });
  });
  beforeEach(async () => fixture.reset());
  afterAll(async () => fixture.close());

  async function seedGraph(
    actor: Awaited<ReturnType<ResearchFixture["createActor"]>>,
  ) {
    const sourceId = newId();
    const targetId = newId();
    const typeId = newId();
    await fixture.database.insert(people).values([
      {
        id: sourceId,
        workspaceId: actor.workspaceId,
        displayName: "Idempotent source",
        sortName: "Source, Idempotent",
        sensitivity: "internal",
        createdBy: actor.principalId,
        updatedBy: actor.principalId,
      },
      {
        id: targetId,
        workspaceId: actor.workspaceId,
        displayName: "Idempotent target",
        sortName: "Target, Idempotent",
        sensitivity: "internal",
        createdBy: actor.principalId,
        updatedBy: actor.principalId,
      },
    ]);
    await fixture.database.insert(relationshipTypes).values({
      id: typeId,
      workspaceId: actor.workspaceId,
      key: `idempotent-${typeId}`,
      forwardLabel: "knows",
      inverseLabel: "known by",
      directed: true,
      createdBy: actor.principalId,
      updatedBy: actor.principalId,
    });
    await fixture.database.insert(relationships).values({
      id: newId(),
      workspaceId: actor.workspaceId,
      sourcePersonId: sourceId,
      targetPersonId: targetId,
      relationshipTypeId: typeId,
      sensitivity: "internal",
      createdBy: actor.principalId,
      updatedBy: actor.principalId,
    });
  }

  it("converges snapshot, run, rerun, and replay retries without duplicate effects", async () => {
    const actor = await fixture.createActor();
    await seedGraph(actor);
    const filter = {
      edgeLimit: 10,
      includeIsolates: true,
      mode: "WORKSPACE" as const,
      nodeLimit: 10,
    };

    const snapshotInput = {
      algorithm: "DEGREE" as const,
      filter,
      idempotencyKey: "graph-analysis-snapshot-replay-v1",
    };
    const createSnapshot = () =>
      fixture.execute<{
        createGraphSnapshot: { id: string; manifestHash: string };
      }>({
        jar: actor.jar,
        operationName: "CreateGraphSnapshot",
        query: CreateGraphSnapshotDocument,
        variables: { input: snapshotInput },
      });
    const [snapshotFirst, snapshotReplay] = await Promise.all([
      createSnapshot(),
      createSnapshot(),
    ]);
    expect(snapshotFirst.body?.errors).toBeUndefined();
    expect(snapshotReplay.body?.errors).toBeUndefined();
    const snapshot = required(
      snapshotFirst.body?.data?.createGraphSnapshot,
      "snapshot",
    );
    expect(snapshotReplay.body?.data?.createGraphSnapshot).toEqual(snapshot);

    expectGraphQLError(
      await fixture.execute({
        jar: actor.jar,
        operationName: "CreateGraphSnapshot",
        query: CreateGraphSnapshotDocument,
        variables: {
          input: { ...snapshotInput, algorithm: "PAGERANK" as const },
        },
      }),
      "CONFLICT",
    );

    const runInput = {
      algorithm: "DEGREE" as const,
      filter,
      idempotencyKey: "graph-analysis-run-replay-v1",
    };
    const run = () =>
      fixture.execute<{
        runGraphAnalysis: {
          graph: { fingerprint: string; generatedAt: string };
          metrics: Array<{ personId: string; value: number }>;
          run: { graphSnapshotId: string; id: string };
        };
      }>({
        jar: actor.jar,
        operationName: "RunGraphAnalysis",
        query: RunGraphAnalysisDocument,
        variables: { input: runInput },
      });
    const [runFirst, runReplay] = await Promise.all([run(), run()]);
    expect(runFirst.body?.errors).toBeUndefined();
    expect(runReplay.body?.errors).toBeUndefined();
    const analysis = required(
      runFirst.body?.data?.runGraphAnalysis,
      "analysis run",
    );
    expect(runReplay.body?.data?.runGraphAnalysis).toEqual(analysis);
    expectGraphQLError(
      await fixture.execute({
        jar: actor.jar,
        operationName: "RunGraphAnalysis",
        query: RunGraphAnalysisDocument,
        variables: {
          input: { ...runInput, algorithm: "PAGERANK" as const },
        },
      }),
      "CONFLICT",
    );

    const rerunInput = {
      algorithm: "PAGERANK" as const,
      idempotencyKey: "graph-analysis-rerun-replay-v1",
      snapshotId: analysis.run.graphSnapshotId,
    };
    const rerun = () =>
      fixture.execute<{
        rerunGraphAnalysis: {
          graph: { fingerprint: string; generatedAt: string };
          metrics: Array<{ personId: string; value: number }>;
          run: { graphSnapshotId: string; id: string };
        };
      }>({
        jar: actor.jar,
        operationName: "RerunGraphAnalysis",
        query: RerunGraphAnalysisDocument,
        variables: { input: rerunInput },
      });
    const rerunFirst = await rerun();
    const rerunReplay = await rerun();
    expect(rerunFirst.body?.errors).toBeUndefined();
    expect(rerunReplay.body?.errors).toBeUndefined();
    expect(rerunReplay.body?.data?.rerunGraphAnalysis).toEqual(
      rerunFirst.body?.data?.rerunGraphAnalysis,
    );
    expectGraphQLError(
      await fixture.execute({
        jar: actor.jar,
        operationName: "RerunGraphAnalysis",
        query: RerunGraphAnalysisDocument,
        variables: {
          input: { ...rerunInput, algorithm: "DEGREE" as const },
        },
      }),
      "CONFLICT",
    );

    const replayInput = {
      idempotencyKey: "graph-snapshot-validation-replay-v1",
      snapshotId: snapshot.id,
    };
    const replaySnapshot = () =>
      fixture.execute<{
        replayGraphSnapshot: {
          snapshot: { id: string; manifestHash: string } | null;
          valid: boolean;
        };
      }>({
        jar: actor.jar,
        operationName: "ReplayGraphSnapshot",
        query: ReplayGraphSnapshotDocument,
        variables: { input: replayInput },
      });
    const replayFirst = await replaySnapshot();
    const replayAgain = await replaySnapshot();
    expect(replayFirst.body?.errors).toBeUndefined();
    expect(replayAgain.body).toEqual(replayFirst.body);
    expectGraphQLError(
      await fixture.execute({
        jar: actor.jar,
        operationName: "ReplayGraphSnapshot",
        query: ReplayGraphSnapshotDocument,
        variables: {
          input: {
            ...replayInput,
            snapshotId: analysis.run.graphSnapshotId,
          },
        },
      }),
      "CONFLICT",
    );

    expect(await fixture.database.select().from(graphSnapshots)).toHaveLength(
      3,
    );
    expect(await fixture.database.select().from(analysisRuns)).toHaveLength(2);
    expect(await fixture.database.select().from(analysisResults)).toHaveLength(
      4,
    );
    expect(await fixture.database.select().from(personMetrics)).toHaveLength(4);
    for (const [action, resourceId] of [
      ["graph_snapshot.create", snapshot.id],
      ["graph_analysis.run", analysis.run.id],
      [
        "graph_analysis.rerun",
        required(rerunFirst.body?.data?.rerunGraphAnalysis?.run.id, "rerun ID"),
      ],
      ["graph_snapshot.replay", snapshot.id],
    ] as const) {
      expect(
        await fixture.database
          .select({ id: auditEvents.id })
          .from(auditEvents)
          .where(
            and(
              eq(auditEvents.workspaceId, actor.workspaceId),
              eq(auditEvents.action, action),
              eq(auditEvents.resourceId, resourceId),
            ),
          ),
      ).toHaveLength(1);
    }

    const claims = await fixture.database
      .select()
      .from(locationMutationIdempotency)
      .where(eq(locationMutationIdempotency.workspaceId, actor.workspaceId));
    expect(claims).toHaveLength(4);
    expect(JSON.stringify(claims)).not.toContain(
      "graph-analysis-run-replay-v1",
    );
  });

  it("does not let another principal replay an actor-bound snapshot", async () => {
    const owner = await fixture.createActor();
    await seedGraph(owner);
    const created = await fixture.execute<{
      createGraphSnapshot: { id: string };
    }>({
      jar: owner.jar,
      operationName: "CreateGraphSnapshot",
      query: CreateGraphSnapshotDocument,
      variables: {
        input: {
          algorithm: "DEGREE",
          filter: { mode: "WORKSPACE" },
          idempotencyKey: "principal-bound-snapshot-create-v1",
        },
      },
    });
    const snapshotId = required(
      created.body?.data?.createGraphSnapshot.id,
      "owner snapshot",
    );
    const other = await fixture.createWorkspaceMember(owner, "admin");
    const denied = await fixture.execute({
      jar: other.jar,
      operationName: "ReplayGraphSnapshot",
      query: ReplayGraphSnapshotDocument,
      variables: {
        input: {
          idempotencyKey: "principal-bound-snapshot-replay-v1",
          snapshotId,
        },
      },
    });
    expectGraphQLError(denied, "NOT_FOUND");
    const outsider = await fixture.createActor();
    expectGraphQLError(
      await fixture.execute({
        jar: outsider.jar,
        operationName: "ReplayGraphSnapshot",
        query: ReplayGraphSnapshotDocument,
        variables: {
          input: {
            idempotencyKey: "workspace-bound-snapshot-replay-v1",
            snapshotId,
          },
        },
      }),
      "NOT_FOUND",
    );
    expect(
      await fixture.database
        .select({ id: auditEvents.id })
        .from(auditEvents)
        .where(
          and(
            eq(auditEvents.workspaceId, owner.workspaceId),
            eq(auditEvents.action, "graph_snapshot.replay"),
            eq(auditEvents.resourceId, snapshotId),
          ),
        ),
    ).toHaveLength(0);
  });

  it("fails closed on malformed snapshot, analysis, and replay references", async () => {
    const actor = await fixture.createActor();
    await seedGraph(actor);
    const snapshotInput = {
      algorithm: "DEGREE" as const,
      filter: { mode: "WORKSPACE" as const },
      idempotencyKey: "malformed-snapshot-reference-v1",
    };
    const createSnapshot = () =>
      fixture.execute<{ createGraphSnapshot: { id: string } }>({
        jar: actor.jar,
        operationName: "CreateGraphSnapshot",
        query: CreateGraphSnapshotDocument,
        variables: { input: snapshotInput },
      });
    const created = await createSnapshot();
    const snapshotId = required(
      created.body?.data?.createGraphSnapshot.id,
      "snapshot",
    );
    await fixture.database
      .update(locationMutationIdempotency)
      .set({ responseReference: { snapshotId } })
      .where(
        and(
          eq(locationMutationIdempotency.workspaceId, actor.workspaceId),
          eq(
            locationMutationIdempotency.operation,
            "graph_snapshot.create.graphql",
          ),
        ),
      );
    expectGraphQLError(await createSnapshot(), "PRECONDITION_FAILED");

    const runInput = {
      algorithm: "DEGREE" as const,
      filter: { mode: "WORKSPACE" as const },
      idempotencyKey: "malformed-analysis-reference-v1",
    };
    const run = () =>
      fixture.execute<{ runGraphAnalysis: { run: { id: string } } }>({
        jar: actor.jar,
        operationName: "RunGraphAnalysis",
        query: RunGraphAnalysisDocument,
        variables: { input: runInput },
      });
    const analysis = await run();
    expect(analysis.body?.errors).toBeUndefined();
    await fixture.database
      .update(locationMutationIdempotency)
      .set({ responseReference: { runId: "not-a-uuid" } })
      .where(
        and(
          eq(locationMutationIdempotency.workspaceId, actor.workspaceId),
          eq(
            locationMutationIdempotency.operation,
            "graph_analysis.run.graphql",
          ),
        ),
      );
    expectGraphQLError(await run(), "PRECONDITION_FAILED");

    const replayInput = {
      idempotencyKey: "malformed-replay-reference-v1",
      snapshotId,
    };
    const replay = () =>
      fixture.execute({
        jar: actor.jar,
        operationName: "ReplayGraphSnapshot",
        query: ReplayGraphSnapshotDocument,
        variables: { input: replayInput },
      });
    expect((await replay()).body?.errors).toBeUndefined();
    await fixture.database
      .update(locationMutationIdempotency)
      .set({
        responseReference: {
          manifestHash: "11".repeat(32),
          snapshotId,
          valid: false,
        },
      })
      .where(
        and(
          eq(locationMutationIdempotency.workspaceId, actor.workspaceId),
          eq(
            locationMutationIdempotency.operation,
            "graph_snapshot.replay.graphql",
          ),
        ),
      );
    expectGraphQLError(await replay(), "PRECONDITION_FAILED");
  });
});
