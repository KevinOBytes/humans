// @vitest-environment node

import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { locationMutationIdempotency } from "@/db/schema/locations";
import { auditEvents } from "@/db/schema/operations";
import {
  ArchivePersonEventDocument,
  ArchivePersonNameDocument,
  CreatePersonEventDocument,
  CreatePersonNameDocument,
  UpdatePersonEventDocument,
  UpdatePersonNameDocument,
} from "@/graphql/generated/graphql";

import { expectGraphQLError, type SessionActor } from "../support/graphql";
import { ResearchFixture } from "../support/research-fixture";

const liveDescribe = process.env.TEST_DATABASE_URL ? describe : describe.skip;

type RecordRow = {
  id: string;
  version: number;
};

type MutationOutcome = {
  code: string | null;
  currentVersion: number | null;
  event?: RecordRow | null;
  name?: RecordRow | null;
};

const domains = [
  {
    auditKind: "personName",
    field: "name",
    operationKind: "person_name",
    root: "PersonName",
    create: CreatePersonNameDocument,
    update: UpdatePersonNameDocument,
    archive: ArchivePersonNameDocument,
    input: (personId: string) => ({
      personId,
      fullName: "Fictional Ada Example",
      kind: "ALIAS",
    }),
    changedCreate: { fullName: "Fictional Ada Changed" },
    change: { fullName: "Fictional Ada Updated" },
    changedUpdate: { fullName: "Fictional Ada Conflicting" },
    secretValues: ["Fictional Ada Example", "Fictional Ada Updated"],
  },
  {
    auditKind: "personEvent",
    field: "event",
    operationKind: "person_event",
    root: "PersonEvent",
    create: CreatePersonEventDocument,
    update: UpdatePersonEventDocument,
    archive: ArchivePersonEventDocument,
    input: (personId: string) => ({
      personId,
      eventKind: "career",
      title: "Started fictional research",
      earliestAt: "2020-01-01T00:00:00.000Z",
    }),
    changedCreate: { title: "Started conflicting research" },
    change: { title: "Started independent fictional research" },
    changedUpdate: { title: "Started conflicting independent research" },
    secretValues: [
      "Started fictional research",
      "Started independent fictional research",
    ],
  },
] as const;

function required<T>(value: T | null | undefined): T {
  if (value == null) throw new Error("Expected a successful mutation resource");
  return value;
}

liveDescribe.each(domains)("generated $root durable idempotency", (domain) => {
  let fixture: ResearchFixture;

  beforeAll(() => {
    fixture = new ResearchFixture();
  });
  beforeEach(async () => fixture.reset());
  afterAll(async () => fixture.close());

  async function setup() {
    const actor = await fixture.createActor();
    const person = await fixture.createPerson(actor, {
      displayName: "Fictional history subject",
    });
    expect(person.body?.errors).toBeUndefined();
    return {
      actor,
      input: {
        ...domain.input(required(person.body?.data?.createPerson?.person?.id)),
        idempotencyKey: "same-raw-create-key",
      },
    };
  }

  function execute(
    actor: SessionActor,
    action: "archive" | "create" | "update",
    input: Record<string, unknown>,
  ) {
    return fixture.execute<Record<string, MutationOutcome>>({
      jar: actor.jar,
      query: domain[action],
      variables: { input },
    });
  }

  async function concurrent(
    actor: SessionActor,
    action: "archive" | "create" | "update",
    input: Record<string, unknown>,
  ) {
    const [first, replay] = await Promise.all([
      execute(actor, action, input),
      execute(actor, action, input),
    ]);
    expect(first.body?.errors).toBeUndefined();
    expect(replay.body?.errors).toBeUndefined();
    const field = `${action}${domain.root}`;
    const outcome = required(first.body?.data?.[field]);
    expect(replay.body?.data?.[field]).toEqual(outcome);
    expect(outcome.code).toBeNull();

    const claims = await fixture.database
      .select()
      .from(locationMutationIdempotency)
      .where(
        and(
          eq(locationMutationIdempotency.workspaceId, actor.workspaceId),
          eq(
            locationMutationIdempotency.operation,
            `${domain.operationKind}.${action}.graphql`,
          ),
        ),
      );
    expect(claims).toHaveLength(1);
    expect(JSON.stringify(claims)).not.toContain(input.idempotencyKey);
    for (const secret of domain.secretValues) {
      expect(JSON.stringify(claims)).not.toContain(secret);
    }

    const audits = await fixture.database
      .select()
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.workspaceId, actor.workspaceId),
          eq(auditEvents.action, `${domain.auditKind}.${action}`),
        ),
      );
    expect(audits).toHaveLength(1);
    for (const secret of domain.secretValues) {
      expect(JSON.stringify(audits)).not.toContain(secret);
    }
    return outcome;
  }

  it("converges concurrent create, update, and archive while conflicting changed material", async () => {
    const { actor, input } = await setup();
    const created = required(
      (await concurrent(actor, "create", input))[domain.field],
    );
    const updateInput = {
      id: created.id,
      expectedVersion: created.version,
      idempotencyKey: "same-raw-update-key",
      ...domain.change,
    };
    const updated = required(
      (await concurrent(actor, "update", updateInput))[domain.field],
    );
    expect(updated.version).toBe(2);

    expectGraphQLError(
      await execute(actor, "create", {
        ...input,
        ...domain.changedCreate,
      }),
      "CONFLICT",
    );
    expectGraphQLError(
      await execute(actor, "update", {
        ...updateInput,
        ...domain.changedUpdate,
      }),
      "CONFLICT",
    );

    const archiveInput = {
      id: updated.id,
      expectedVersion: updated.version,
      idempotencyKey: "same-raw-archive-key",
    };
    await concurrent(actor, "archive", archiveInput);
    expectGraphQLError(
      await execute(actor, "archive", {
        ...archiveInput,
        expectedVersion: 99,
      }),
      "CONFLICT",
    );
  });

  it("rejects non-exact and malformed replay references", async () => {
    const { actor, input } = await setup();
    let row = required(
      (await execute(actor, "create", input)).body?.data?.[
        `create${domain.root}`
      ]?.[domain.field],
    );

    for (const action of ["create", "update", "archive"] as const) {
      const material =
        action === "create"
          ? input
          : {
              id: row.id,
              expectedVersion: row.version,
              idempotencyKey: `malformed-${action}`,
              ...(action === "update" ? domain.change : {}),
            };
      if (action !== "create") {
        const result = await execute(actor, action, material);
        expect(result.body?.errors).toBeUndefined();
        row = required(
          result.body?.data?.[`${action}${domain.root}`]?.[domain.field],
        );
      }
      const [claim] = await fixture.database
        .select()
        .from(locationMutationIdempotency)
        .where(
          and(
            eq(
              locationMutationIdempotency.operation,
              `${domain.operationKind}.${action}.graphql`,
            ),
            eq(locationMutationIdempotency.actorPrincipalId, actor.principalId),
          ),
        );
      const responseReference = required(claim).responseReference;
      await fixture.database
        .update(locationMutationIdempotency)
        .set({
          responseReference: {
            ...(required(responseReference) as Record<string, unknown>),
            unexpected: "must-not-be-accepted",
          },
        })
        .where(eq(locationMutationIdempotency.id, required(claim).id));
      expectGraphQLError(
        await execute(actor, action, material),
        "VALIDATION_FAILED",
      );

      const idKey = domain.field === "name" ? "nameId" : "eventId";
      await fixture.database
        .update(locationMutationIdempotency)
        .set({ responseReference: { [idKey]: "not-a-uuid", version: 1 } })
        .where(eq(locationMutationIdempotency.id, required(claim).id));
      expectGraphQLError(
        await execute(actor, action, material),
        "VALIDATION_FAILED",
      );
    }

    const audits = await fixture.database
      .select()
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.workspaceId, actor.workspaceId),
          eq(auditEvents.resourceKind, domain.auditKind),
        ),
      );
    expect(audits).toHaveLength(3);
  });

  it("serializes expired create and update takeover without trusting stale references", async () => {
    const { actor, input } = await setup();
    const initial = await execute(actor, "create", input);
    expect(initial.body?.errors).toBeUndefined();
    const old = required(
      initial.body?.data?.[`create${domain.root}`]?.[domain.field],
    );
    await fixture.database
      .update(locationMutationIdempotency)
      .set({
        expiresAt: new Date(Date.now() - 1_000),
        responseReference: { stale: "must-not-be-replayed" },
      })
      .where(
        eq(
          locationMutationIdempotency.operation,
          `${domain.operationKind}.create.graphql`,
        ),
      );

    const [firstCreate, replayCreate] = await Promise.all([
      execute(actor, "create", input),
      execute(actor, "create", input),
    ]);
    expect(firstCreate.body?.errors).toBeUndefined();
    expect(replayCreate.body?.errors).toBeUndefined();
    expect(replayCreate.body?.data).toEqual(firstCreate.body?.data);
    let current = required(
      firstCreate.body?.data?.[`create${domain.root}`]?.[domain.field],
    );
    expect(current.id).not.toBe(old.id);

    const updateInput = {
      id: current.id,
      expectedVersion: current.version,
      idempotencyKey: "expiry-update-key",
      ...domain.change,
    };
    const initialUpdate = await execute(actor, "update", updateInput);
    expect(initialUpdate.body?.errors).toBeUndefined();
    current = required(
      initialUpdate.body?.data?.[`update${domain.root}`]?.[domain.field],
    );
    await fixture.database
      .update(locationMutationIdempotency)
      .set({
        expiresAt: new Date(Date.now() - 1_000),
        responseReference: { stale: "must-not-be-replayed" },
      })
      .where(
        eq(
          locationMutationIdempotency.operation,
          `${domain.operationKind}.update.graphql`,
        ),
      );
    const takeoverInput = {
      ...updateInput,
      expectedVersion: current.version,
    };
    const [firstUpdate, replayUpdate] = await Promise.all([
      execute(actor, "update", takeoverInput),
      execute(actor, "update", takeoverInput),
    ]);
    expect(firstUpdate.body?.errors).toBeUndefined();
    expect(replayUpdate.body?.errors).toBeUndefined();
    expect(replayUpdate.body?.data).toEqual(firstUpdate.body?.data);
    expect(
      firstUpdate.body?.data?.[`update${domain.root}`]?.[domain.field]?.version,
    ).toBe(3);

    const createAudits = await fixture.database
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.action, `${domain.auditKind}.create`));
    const updateAudits = await fixture.database
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.action, `${domain.auditKind}.update`));
    expect(createAudits).toHaveLength(2);
    expect(updateAudits).toHaveLength(2);
  });

  it("fences raw keys by workspace and principal and conceals foreign records", async () => {
    const { actor, input } = await setup();
    const first = await execute(actor, "create", input);
    expect(first.body?.errors).toBeUndefined();
    const original = required(
      first.body?.data?.[`create${domain.root}`]?.[domain.field],
    );

    const foreign = await setup();
    const second = await execute(foreign.actor, "create", foreign.input);
    expect(second.body?.errors).toBeUndefined();
    expect(
      second.body?.data?.[`create${domain.root}`]?.[domain.field]?.id,
    ).not.toBe(original.id);

    const colleague = await fixture.createWorkspaceMember(actor, "admin");
    const third = await execute(colleague, "create", input);
    expect(third.body?.errors).toBeUndefined();
    expect(
      third.body?.data?.[`create${domain.root}`]?.[domain.field]?.id,
    ).not.toBe(original.id);

    expectGraphQLError(
      await execute(foreign.actor, "update", {
        id: original.id,
        expectedVersion: original.version,
        idempotencyKey: "foreign-update-key",
        ...domain.change,
      }),
      "NOT_FOUND",
    );

    const claims = await fixture.database
      .select()
      .from(locationMutationIdempotency)
      .where(
        eq(
          locationMutationIdempotency.operation,
          `${domain.operationKind}.create.graphql`,
        ),
      );
    expect(claims).toHaveLength(3);
    expect(new Set(claims.map((claim) => claim.keyHash)).size).toBe(3);
  });

  it("preserves the unkeyed legacy lifecycle", async () => {
    const { actor, input } = await setup();
    const created = required(
      (await execute(actor, "create", { ...input, idempotencyKey: null })).body
        ?.data?.[`create${domain.root}`]?.[domain.field],
    );
    const updated = required(
      (
        await execute(actor, "update", {
          id: created.id,
          expectedVersion: created.version,
          ...domain.change,
        })
      ).body?.data?.[`update${domain.root}`]?.[domain.field],
    );
    const archived = await execute(actor, "archive", {
      id: updated.id,
      expectedVersion: updated.version,
    });
    expect(archived.body?.errors).toBeUndefined();
    expect(
      archived.body?.data?.[`archive${domain.root}`]?.[domain.field]?.version,
    ).toBe(3);

    const claims = await fixture.database
      .select()
      .from(locationMutationIdempotency);
    expect(claims).toHaveLength(0);
  });
});
