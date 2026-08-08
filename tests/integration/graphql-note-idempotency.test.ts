// @vitest-environment node

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";

import { auditEvents } from "@/db/schema/operations";
import { locationMutationIdempotency } from "@/db/schema/locations";
import {
  ArchiveNoteDocument,
  CreateNoteDocument,
  UpdateNoteDocument,
} from "@/graphql/generated/graphql";

import { expectGraphQLError, type SessionActor } from "../support/graphql";
import { ResearchFixture } from "../support/research-fixture";

const liveDescribe = process.env.TEST_DATABASE_URL ? describe : describe.skip;

function required<T>(value: T | null | undefined, label: string): T {
  if (value == null) throw new Error(`Missing ${label}`);
  return value;
}

liveDescribe("note mutation idempotency", () => {
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

  function createNote(actor: SessionActor, input: Record<string, unknown>) {
    return fixture.execute<{
      createNote: {
        code: string | null;
        note: { id: string; version: number } | null;
      };
    }>({
      jar: actor.jar,
      operationName: "CreateNote",
      query: CreateNoteDocument,
      variables: { input },
    });
  }

  it("replays create, update, and archive without duplicate effects", async () => {
    const actor = await fixture.createActor();
    const createInput = {
      idempotencyKey: "note-create-replay-v1",
      content: { plainText: "Initial note" },
    };
    const [first, replay] = await Promise.all([
      createNote(actor, createInput),
      createNote(actor, createInput),
    ]);
    expect(first.body?.errors).toBeUndefined();
    expect(replay.body?.errors).toBeUndefined();
    const created = required(first.body?.data?.createNote.note, "created note");
    expect(replay.body?.data?.createNote.note).toEqual(created);

    expect(
      await fixture.database
        .select({ id: auditEvents.id })
        .from(auditEvents)
        .where(
          and(
            eq(auditEvents.workspaceId, actor.workspaceId),
            eq(auditEvents.action, "note.create"),
          ),
        ),
    ).toHaveLength(1);
    expect(
      await fixture.database
        .select()
        .from(locationMutationIdempotency)
        .where(
          and(
            eq(locationMutationIdempotency.workspaceId, actor.workspaceId),
            eq(locationMutationIdempotency.operation, "note.create.graphql"),
          ),
        ),
    ).toHaveLength(1);

    const updateInput = {
      id: created.id,
      expectedVersion: created.version,
      idempotencyKey: "note-update-replay-v1",
      content: { plainText: "Updated note" },
    };
    const update = () =>
      fixture.execute<{
        updateNote: {
          code: string | null;
          note: { id: string; version: number } | null;
        };
      }>({
        jar: actor.jar,
        operationName: "UpdateNote",
        query: UpdateNoteDocument,
        variables: { input: updateInput },
      });
    const [updatedFirst, updatedReplay] = await Promise.all([
      update(),
      update(),
    ]);
    expect(updatedFirst.body?.errors).toBeUndefined();
    expect(updatedReplay.body?.errors).toBeUndefined();
    const updated = required(
      updatedFirst.body?.data?.updateNote.note,
      "updated note",
    );
    expect(updated.version).toBe(2);
    expect(updatedReplay.body?.data?.updateNote.note).toEqual(updated);
    expectGraphQLError(
      await updateNoteChanged(actor, fixture, {
        ...updateInput,
        content: { plainText: "Changed request" },
      }),
      "CONFLICT",
    );

    const archiveInput = {
      id: updated.id,
      expectedVersion: updated.version,
      idempotencyKey: "note-archive-replay-v1",
    };
    const archive = () =>
      fixture.execute<{
        archiveNote: {
          code: string | null;
          note: { id: string; version: number } | null;
        };
      }>({
        jar: actor.jar,
        operationName: "ArchiveNote",
        query: ArchiveNoteDocument,
        variables: { input: archiveInput },
      });
    const [archivedFirst, archivedReplay] = await Promise.all([
      archive(),
      archive(),
    ]);
    expect(archivedFirst.body?.errors).toBeUndefined();
    expect(archivedReplay.body?.errors).toBeUndefined();
    const archived = required(
      archivedFirst.body?.data?.archiveNote.note,
      "archived note",
    );
    expect(archived.version).toBe(3);
    expect(archivedReplay.body?.data?.archiveNote.note).toEqual(archived);
    expect(
      await fixture.database
        .select({ id: auditEvents.id })
        .from(auditEvents)
        .where(
          and(
            eq(auditEvents.workspaceId, actor.workspaceId),
            eq(auditEvents.action, "note.archive"),
          ),
        ),
    ).toHaveLength(1);
  });
});

function updateNoteChanged(
  actor: SessionActor,
  fixture: ResearchFixture,
  input: Record<string, unknown>,
) {
  return fixture.execute({
    jar: actor.jar,
    operationName: "UpdateNote",
    query: UpdateNoteDocument,
    variables: { input },
  });
}
