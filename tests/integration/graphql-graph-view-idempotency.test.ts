// @vitest-environment node

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";

import { auditEvents } from "@/db/schema/operations";
import { locationMutationIdempotency } from "@/db/schema/locations";
import {
  ArchiveGraphViewDocument,
  CreateGraphViewDocument,
  UpdateGraphViewDocument,
} from "@/graphql/generated/graphql";

import { expectGraphQLError } from "../support/graphql";
import { ResearchFixture } from "../support/research-fixture";

const liveDescribe = process.env.TEST_DATABASE_URL ? describe : describe.skip;

function required<T>(value: T | null | undefined, label: string): T {
  if (value == null) throw new Error(`Missing ${label}`);
  return value;
}

liveDescribe("graph view mutation idempotency", () => {
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

  it("replays create, update, and archive without duplicate effects", async () => {
    const actor = await fixture.createActor();
    const createInput = {
      filter: { mode: "WORKSPACE" },
      idempotencyKey: "graph-view-create-replay-v1",
      name: "Idempotent graph view",
      sharing: "PRIVATE",
    };
    const create = () =>
      fixture.execute<{
        createGraphView: { id: string; version: number };
      }>({
        jar: actor.jar,
        operationName: "CreateGraphView",
        query: CreateGraphViewDocument,
        variables: { input: createInput },
      });
    const [first, replay] = await Promise.all([create(), create()]);
    expect(first.body?.errors).toBeUndefined();
    expect(replay.body?.errors).toBeUndefined();
    const created = required(
      first.body?.data?.createGraphView,
      "created graph view",
    );
    expect(replay.body?.data?.createGraphView).toEqual(created);
    expect(
      await fixture.database
        .select({ id: auditEvents.id })
        .from(auditEvents)
        .where(
          and(
            eq(auditEvents.workspaceId, actor.workspaceId),
            eq(auditEvents.action, "graph_view.create"),
            eq(auditEvents.resourceId, created.id),
          ),
        ),
    ).toHaveLength(1);

    const updateInput = {
      expectedVersion: created.version,
      id: created.id,
      idempotencyKey: "graph-view-update-replay-v1",
      name: "Idempotent graph view updated",
    };
    const update = () =>
      fixture.execute<{
        updateGraphView: { id: string; version: number; name: string };
      }>({
        jar: actor.jar,
        operationName: "UpdateGraphView",
        query: UpdateGraphViewDocument,
        variables: { input: updateInput },
      });
    const [updatedFirst, updatedReplay] = await Promise.all([
      update(),
      update(),
    ]);
    expect(updatedFirst.body?.errors).toBeUndefined();
    expect(updatedReplay.body?.errors).toBeUndefined();
    const updated = required(
      updatedFirst.body?.data?.updateGraphView,
      "updated graph view",
    );
    expect(updated).toMatchObject({
      id: created.id,
      name: updateInput.name,
      version: 2,
    });
    expect(updatedReplay.body?.data?.updateGraphView).toEqual(updated);
    expect(
      await fixture.database
        .select({ id: auditEvents.id })
        .from(auditEvents)
        .where(
          and(
            eq(auditEvents.workspaceId, actor.workspaceId),
            eq(auditEvents.action, "graph_view.update"),
            eq(auditEvents.resourceId, created.id),
          ),
        ),
    ).toHaveLength(1);
    expectGraphQLError(
      await fixture.execute({
        jar: actor.jar,
        operationName: "UpdateGraphView",
        query: UpdateGraphViewDocument,
        variables: { input: { ...updateInput, name: "Changed request" } },
      }),
      "CONFLICT",
    );

    const archiveInput = {
      expectedVersion: updated.version,
      id: created.id,
      idempotencyKey: "graph-view-archive-replay-v1",
    };
    const archive = () =>
      fixture.execute<{
        archiveGraphView: { id: string; version: number };
      }>({
        jar: actor.jar,
        operationName: "ArchiveGraphView",
        query: ArchiveGraphViewDocument,
        variables: { input: archiveInput },
      });
    const [archivedFirst, archivedReplay] = await Promise.all([
      archive(),
      archive(),
    ]);
    expect(archivedFirst.body?.errors).toBeUndefined();
    expect(archivedReplay.body?.errors).toBeUndefined();
    const archived = required(
      archivedFirst.body?.data?.archiveGraphView,
      "archived graph view",
    );
    expect(archived).toEqual({ id: created.id, version: 3 });
    expect(archivedReplay.body?.data?.archiveGraphView).toEqual(archived);
    expect(
      await fixture.database
        .select({ id: auditEvents.id })
        .from(auditEvents)
        .where(
          and(
            eq(auditEvents.workspaceId, actor.workspaceId),
            eq(auditEvents.action, "graph_view.archive"),
            eq(auditEvents.resourceId, created.id),
          ),
        ),
    ).toHaveLength(1);
    expect(
      await fixture.database
        .select({ id: locationMutationIdempotency.id })
        .from(locationMutationIdempotency)
        .where(
          and(
            eq(locationMutationIdempotency.workspaceId, actor.workspaceId),
            eq(
              locationMutationIdempotency.operation,
              "graph_view.create.graphql",
            ),
          ),
        ),
    ).toHaveLength(1);
  });
});
