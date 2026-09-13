// @vitest-environment node

import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { locationMutationIdempotency } from "@/db/schema/locations";
import { auditEvents } from "@/db/schema/operations";
import {
  ArchivePersonAddressDocument,
  ArchivePersonContactDocument,
  ArchivePhoneContactDocument,
  ArchivePlaceDocument,
  CreatePersonAddressDocument,
  CreatePersonContactDocument,
  CreatePhoneContactDocument,
  CreatePlaceDocument,
  UpdatePersonAddressDocument,
  UpdatePersonContactDocument,
  UpdatePhoneContactDocument,
  UpdatePlaceDocument,
} from "@/graphql/generated/graphql";

import { expectGraphQLError, type SessionActor } from "../support/graphql";
import { ResearchFixture } from "../support/research-fixture";

const liveDescribe = process.env.TEST_DATABASE_URL ? describe : describe.skip;
type Row = {
  id?: string;
  associationId?: string;
  contactPointId?: string;
  addressId?: string;
  version: number;
  contactVersion?: number;
  addressVersion?: number;
};
type Outcome = {
  code: string | null;
  currentVersion: number | null;
  contact?: Row | null;
  address?: Row | null;
  place?: Row | null;
};
const domains = [
  {
    name: "contact",
    field: "contact",
    root: "PersonContact",
    audit: "contactPoint",
    create: CreatePersonContactDocument,
    update: UpdatePersonContactDocument,
    archive: ArchivePersonContactDocument,
    input: (personId: string) => ({
      personId,
      kind: "EMAIL",
      value: "fictional@example.test",
      usageKind: "work",
    }),
    change: { label: "Changed contact" },
    identity: (row: Row) => ({
      associationId: row.associationId,
      expectedVersion: row.version,
      expectedContactVersion: row.contactVersion,
    }),
  },
  {
    name: "contact",
    field: "contact",
    root: "PhoneContact",
    audit: "contactPoint",
    create: CreatePhoneContactDocument,
    update: UpdatePhoneContactDocument,
    archive: ArchivePhoneContactDocument,
    input: (personId: string) => ({
      personId,
      value: "+12025550123",
      usageKind: "work",
    }),
    change: { label: "Changed phone" },
    identity: (row: Row) => ({
      associationId: row.associationId,
      expectedVersion: row.version,
      expectedContactVersion: row.contactVersion,
    }),
  },
  {
    name: "address",
    field: "address",
    root: "PersonAddress",
    audit: "address",
    create: CreatePersonAddressDocument,
    update: UpdatePersonAddressDocument,
    archive: ArchivePersonAddressDocument,
    input: (personId: string) => ({
      personId,
      addressKind: "home",
      line1: "1 Fictional Lane",
      locality: "Example",
      countryCode: "US",
    }),
    change: { locality: "Changed locality" },
    identity: (row: Row) => ({
      associationId: row.associationId,
      expectedVersion: row.version,
      expectedAddressVersion: row.addressVersion,
    }),
  },
  {
    name: "place",
    field: "place",
    root: "Place",
    audit: "place",
    create: CreatePlaceDocument,
    update: UpdatePlaceDocument,
    archive: ArchivePlaceDocument,
    input: () => ({
      name: "Fictional office",
      kind: "building",
    }),
    change: { name: "Changed office" },
    identity: (row: Row) => ({ id: row.id, expectedVersion: row.version }),
  },
] as const;

function required<T>(value: T | null | undefined): T {
  if (value == null) throw new Error("Expected a successful mutation resource");
  return value;
}

liveDescribe.each(domains)("generated $root idempotency", (domain) => {
  let fixture: ResearchFixture;
  beforeAll(() => {
    fixture = new ResearchFixture();
  });
  beforeEach(async () => fixture.reset());
  afterAll(async () => fixture.close());

  async function setup() {
    const actor = await fixture.createActor();
    const person = await fixture.createPerson(actor, {
      displayName: "Fictional retry subject",
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
    action: "create" | "update" | "archive",
    input: Record<string, unknown>,
  ) {
    return fixture.execute<Record<string, Outcome>>({
      jar: actor.jar,
      query: domain[action],
      variables: { input },
    });
  }

  async function concurrent(
    actor: SessionActor,
    action: "create" | "update" | "archive",
    input: Record<string, unknown>,
  ) {
    const [first, replay] = await Promise.all([
      execute(actor, action, input),
      execute(actor, action, input),
    ]);
    expect(first.body?.errors).toBeUndefined();
    expect(replay.body?.errors).toBeUndefined();
    const outcome = required(first.body?.data?.[`${action}${domain.root}`]);
    expect(replay.body?.data?.[`${action}${domain.root}`]).toEqual(outcome);
    expect(outcome.code).toBe(action === "archive" ? "ARCHIVED" : null);
    const claims = await fixture.database
      .select()
      .from(locationMutationIdempotency)
      .where(
        and(
          eq(locationMutationIdempotency.workspaceId, actor.workspaceId),
          eq(
            locationMutationIdempotency.operation,
            `location.${domain.name}.${action}`,
          ),
        ),
      );
    expect(claims).toHaveLength(1);
    const audits = await fixture.database
      .select()
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.workspaceId, actor.workspaceId),
          eq(auditEvents.action, `${domain.audit}.${action}`),
        ),
      );
    expect(audits).toHaveLength(1);
    expect(JSON.stringify(claims)).not.toContain("fictional@example.test");
    expect(JSON.stringify(claims)).not.toContain("Fictional Lane");
    expect(JSON.stringify(claims)).not.toContain(input.idempotencyKey);
    return outcome;
  }

  it("converges concurrent create/update/archive with one claim and audit per operation", async () => {
    const { actor, input } = await setup();
    const created = required(
      (await concurrent(actor, "create", input))[domain.field],
    );
    const updateInput = {
      ...domain.identity(created),
      ...domain.change,
      idempotencyKey: "same-raw-update-key",
    };
    const updated = required(
      (await concurrent(actor, "update", updateInput))[domain.field],
    );
    expect(updated.version).toBe(2);
    expectGraphQLError(
      await execute(actor, "create", { ...input, ...domain.change }),
      "CONFLICT",
    );
    expectGraphQLError(
      await execute(actor, "update", { ...updateInput, expectedVersion: 99 }),
      "CONFLICT",
    );
    const archiveInput = {
      ...domain.identity(updated),
      idempotencyKey: "same-raw-archive-key",
    };
    await concurrent(actor, "archive", archiveInput);
    expectGraphQLError(
      await execute(actor, "archive", { ...archiveInput, expectedVersion: 99 }),
      "CONFLICT",
    );
  });

  it("rejects malformed references for every lifecycle operation before replaying effects", async () => {
    const { actor, input } = await setup();
    let row: Row | undefined;
    for (const action of ["create", "update", "archive"] as const) {
      const material =
        action === "create"
          ? input
          : {
              ...domain.identity(required(row)),
              ...(action === "update" ? domain.change : {}),
              idempotencyKey: `malformed-${action}`,
            };
      const result = await execute(actor, action, material);
      expect(result.body?.errors).toBeUndefined();
      const outcome = required(result.body?.data?.[`${action}${domain.root}`]);
      if (action !== "archive") row = required(outcome[domain.field]);
      const [claim] = await fixture.database
        .select()
        .from(locationMutationIdempotency)
        .where(
          eq(
            locationMutationIdempotency.operation,
            `location.${domain.name}.${action}`,
          ),
        );
      await fixture.database
        .update(locationMutationIdempotency)
        .set({
          responseReference: {
            associationId: null,
            resourceId: "not-a-uuid",
            code: null,
            currentVersion: null,
          },
        })
        .where(eq(locationMutationIdempotency.id, required(claim).id));
      expectGraphQLError(
        await execute(actor, action, material),
        "PRECONDITION_FAILED",
      );
      const audits = await fixture.database
        .select()
        .from(auditEvents)
        .where(eq(auditEvents.action, `${domain.audit}.${action}`));
      expect(audits).toHaveLength(1);
    }
  });

  it("serializes expired claim takeover and does not trust the stale reference", async () => {
    const { actor, input } = await setup();
    const initial = await execute(actor, "create", input);
    expect(initial.body?.errors).toBeUndefined();
    const old = required(
      initial.body?.data?.[`create${domain.root}`]?.[domain.field],
    );
    await fixture.database
      .update(locationMutationIdempotency)
      .set({
        expiresAt: new Date(Date.now() - 1000),
        responseReference: { resourceId: "expired-malformed-reference" },
      })
      .where(
        eq(
          locationMutationIdempotency.operation,
          `location.${domain.name}.create`,
        ),
      );
    const [first, replay] = await Promise.all([
      execute(actor, "create", input),
      execute(actor, "create", input),
    ]);
    expect(first.body?.errors).toBeUndefined();
    expect(replay.body?.errors).toBeUndefined();
    const current = required(
      first.body?.data?.[`create${domain.root}`]?.[domain.field],
    );
    expect(current).not.toEqual(old);
    expect(replay.body?.data).toEqual(first.body?.data);
    const claims = await fixture.database
      .select()
      .from(locationMutationIdempotency)
      .where(
        eq(
          locationMutationIdempotency.operation,
          `location.${domain.name}.create`,
        ),
      );
    expect(claims).toHaveLength(1);
    expect(required(claims[0]).expiresAt.getTime()).toBeGreaterThan(Date.now());
    const audits = await fixture.database
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.action, `${domain.audit}.create`));
    expect(audits).toHaveLength(2);
  });

  it("takes over expired updates with current versions and rejects expired archived resources", async () => {
    const { actor, input } = await setup();
    const created = required(
      (await execute(actor, "create", input)).body?.data?.[
        `create${domain.root}`
      ]?.[domain.field],
    );
    const updateInput = {
      ...domain.identity(created),
      ...domain.change,
      idempotencyKey: "expiry-update",
    };
    const updated = required(
      (await execute(actor, "update", updateInput)).body?.data?.[
        `update${domain.root}`
      ]?.[domain.field],
    );
    await fixture.database
      .update(locationMutationIdempotency)
      .set({
        expiresAt: new Date(Date.now() - 1000),
        responseReference: { resourceId: "expired-invalid" },
      })
      .where(
        eq(
          locationMutationIdempotency.operation,
          `location.${domain.name}.update`,
        ),
      );
    const takeoverInput = { ...updateInput, ...domain.identity(updated) };
    const [first, replay] = await Promise.all([
      execute(actor, "update", takeoverInput),
      execute(actor, "update", takeoverInput),
    ]);
    expect(first.body?.errors).toBeUndefined();
    expect(replay.body?.errors).toBeUndefined();
    expect(replay.body?.data).toEqual(first.body?.data);
    const current = required(
      first.body?.data?.[`update${domain.root}`]?.[domain.field],
    );
    expect(current.version).toBe(3);
    const updateAudits = await fixture.database
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.action, `${domain.audit}.update`));
    expect(updateAudits).toHaveLength(2);
    const claims = await fixture.database
      .select()
      .from(locationMutationIdempotency)
      .where(
        eq(
          locationMutationIdempotency.operation,
          `location.${domain.name}.update`,
        ),
      );
    expect(claims).toHaveLength(1);
    expect(required(claims[0]).expiresAt.getTime()).toBeGreaterThan(Date.now());
    const archiveInput = {
      ...domain.identity(current),
      idempotencyKey: "expiry-archive",
    };
    const archived = await execute(actor, "archive", archiveInput);
    expect(archived.body?.errors).toBeUndefined();
    expect(archived.body?.data?.[`archive${domain.root}`]?.code).toBe(
      "ARCHIVED",
    );
    await fixture.database
      .update(locationMutationIdempotency)
      .set({
        expiresAt: new Date(Date.now() - 1000),
        responseReference: { resourceId: "expired-invalid" },
      })
      .where(
        eq(
          locationMutationIdempotency.operation,
          `location.${domain.name}.archive`,
        ),
      );
    for (const result of await Promise.all([
      execute(actor, "archive", archiveInput),
      execute(actor, "archive", archiveInput),
    ])) {
      expectGraphQLError(result, "NOT_FOUND");
    }
    const archiveAudits = await fixture.database
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.action, `${domain.audit}.archive`));
    expect(archiveAudits).toHaveLength(1);
  });

  it("fences raw keys by workspace and principal and denies foreign resource updates", async () => {
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
      second.body?.data?.[`create${domain.root}`]?.[domain.field],
    ).not.toEqual(original);
    const denied = await execute(foreign.actor, "update", {
      ...domain.identity(original),
      ...domain.change,
      idempotencyKey: "foreign-update",
    });
    expectGraphQLError(denied, "NOT_FOUND");
    const colleague = await fixture.createWorkspaceMember(actor, "admin");
    const third = await execute(colleague, "create", input);
    expect(third.body?.errors).toBeUndefined();
    expect(
      third.body?.data?.[`create${domain.root}`]?.[domain.field],
    ).not.toEqual(original);
    const claims = await fixture.database
      .select()
      .from(locationMutationIdempotency)
      .where(
        eq(
          locationMutationIdempotency.operation,
          `location.${domain.name}.create`,
        ),
      );
    expect(claims).toHaveLength(3);
    expect(new Set(claims.map((claim) => claim.keyHash)).size).toBe(3);
  });
});
