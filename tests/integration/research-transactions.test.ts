// @vitest-environment node

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { and, count, eq } from "drizzle-orm";

import { newId } from "@/db/id";
import { members, sessions } from "@/db/schema/auth";
import { personTags, tags } from "@/db/schema/evidence";
import { factDefinitions, facts } from "@/db/schema/facts";
import { auditEvents, idempotencyKeys } from "@/db/schema/operations";
import {
  externalRecords,
  identityCandidates,
  people,
} from "@/db/schema/people";
import { relationshipTypes, relationships } from "@/db/schema/relationships";
import type { Database } from "@/modules/auth/bootstrap-admin";
import { ensureUserPrincipal } from "@/modules/auth/workspaces";
import type { ResearchServiceContext } from "@/modules/audit/service";
import * as transactionModule from "@/modules/audit/transactions";
import { createFactsService } from "@/modules/facts/service";
import { createPeopleService } from "@/modules/people/service";
import { createRelationshipsService } from "@/modules/relationships/service";
import { disabledSearchIndexMaintenance } from "@/modules/search/index-maintenance";

import type { SessionActor } from "../support/graphql";
import { createTestConnection, createTestDatabase } from "../support/auth";
import { ResearchFixture } from "../support/research-fixture";

const liveDescribe = process.env.TEST_DATABASE_URL ? describe : describe.skip;

type ResponseReference = Readonly<
  Record<string, string | number | boolean | null>
>;

type CanonicalRequestMaterial =
  | boolean
  | null
  | number
  | string
  | readonly CanonicalRequestMaterial[]
  | CanonicalRequestObject;

interface CanonicalRequestObject {
  readonly [key: string]: CanonicalRequestMaterial;
}

declare const derivedResearchIdempotencyBrand: unique symbol;
type DerivedResearchIdempotency = {
  readonly [derivedResearchIdempotencyBrand]: true;
};

const TEST_IDEMPOTENCY_SECRET = "42".repeat(32);
const IMPORT_WRITE_PERMISSIONS = [
  "person:create",
  "fact:create",
  "relationship:create",
] as const;

type DeriveResearchIdempotency = (
  context: ResearchServiceContext,
  input: {
    expiresAt: Date;
    idempotencyKey: string;
    operation: string;
    requestMaterial: Readonly<Record<string, CanonicalRequestMaterial>>;
    secret: string;
  },
) => DerivedResearchIdempotency;

type RunResearchTransaction = <T>(
  context: ResearchServiceContext,
  input: { requiredPermissions: readonly string[] },
  write: (context: ResearchServiceContext) => Promise<T>,
) => Promise<T>;

type RunIdempotentResearchWrite = <T extends ResponseReference>(
  context: ResearchServiceContext,
  input: DerivedResearchIdempotency,
  requiredPermissions: readonly string[],
  write: (context: ResearchServiceContext) => Promise<T>,
) => Promise<{ replayed: boolean; responseReference: T }>;

function transactionFunctions(): {
  deriveResearchIdempotency: DeriveResearchIdempotency;
  runIdempotentResearchWrite: RunIdempotentResearchWrite;
  runResearchTransaction: RunResearchTransaction;
} {
  const functions = transactionModule as typeof transactionModule & {
    deriveResearchIdempotency?: DeriveResearchIdempotency;
    runIdempotentResearchWrite?: RunIdempotentResearchWrite;
    runResearchTransaction?: RunResearchTransaction;
  };
  expect(functions.deriveResearchIdempotency).toBeTypeOf("function");
  expect(functions.runResearchTransaction).toBeTypeOf("function");
  expect(functions.runIdempotentResearchWrite).toBeTypeOf("function");
  return {
    deriveResearchIdempotency:
      functions.deriveResearchIdempotency as DeriveResearchIdempotency,
    runIdempotentResearchWrite:
      functions.runIdempotentResearchWrite as RunIdempotentResearchWrite,
    runResearchTransaction:
      functions.runResearchTransaction as RunResearchTransaction,
  };
}

function hardenedTransactionFunctions(): {
  deriveResearchIdempotency: DeriveResearchIdempotency;
  runIdempotentResearchWrite: RunIdempotentResearchWrite;
  runResearchTransaction: RunResearchTransaction;
} {
  const functions = transactionModule as typeof transactionModule & {
    deriveResearchIdempotency?: DeriveResearchIdempotency;
    runIdempotentResearchWrite?: RunIdempotentResearchWrite;
    runResearchTransaction?: RunResearchTransaction;
  };
  expect(functions.deriveResearchIdempotency).toBeTypeOf("function");
  expect(functions.runResearchTransaction).toBeTypeOf("function");
  expect(functions.runIdempotentResearchWrite).toBeTypeOf("function");
  return {
    deriveResearchIdempotency:
      functions.deriveResearchIdempotency as DeriveResearchIdempotency,
    runIdempotentResearchWrite:
      functions.runIdempotentResearchWrite as RunIdempotentResearchWrite,
    runResearchTransaction:
      functions.runResearchTransaction as RunResearchTransaction,
  };
}

function derivedInput(
  context: ResearchServiceContext,
  input: {
    expiresAt?: Date;
    idempotencyKey: string;
    operation?: string;
    requestMaterial: Readonly<Record<string, CanonicalRequestMaterial>>;
  },
): DerivedResearchIdempotency {
  return transactionFunctions().deriveResearchIdempotency(context, {
    expiresAt: input.expiresAt ?? new Date(Date.now() + 60_000),
    idempotencyKey: input.idempotencyKey,
    operation: input.operation ?? "import.row.commit",
    requestMaterial: input.requestMaterial,
    secret: TEST_IDEMPOTENCY_SECRET,
  });
}

async function serviceContext(
  fixture: ResearchFixture,
  actor: SessionActor,
  permissions: readonly string[] = [
    "person:create",
    "fact:create",
    "relationship:create",
  ],
): Promise<ResearchServiceContext> {
  const [session] = await fixture.database
    .select({ id: sessions.id })
    .from(sessions)
    .where(eq(sessions.userId, actor.userId));
  if (!session) throw new Error("The fixture session is missing.");
  return {
    actor: {
      type: "user",
      id: actor.userId,
      principalId: actor.principalId,
      sessionId: session.id,
      memberId: actor.memberId,
      role: "owner",
    },
    database: fixture.database,
    idempotencyHmacKey: TEST_IDEMPOTENCY_SECRET,
    permissions: new Set(permissions),
    requestId: "019cc7c4-6ed2-7e0a-aed8-e5d451c96bf3",
    searchIndexMaintenance: disabledSearchIndexMaintenance,
    workspaceId: actor.workspaceId,
  };
}

async function installImportDefinitions(
  fixture: ResearchFixture,
  actor: SessionActor,
): Promise<{ definitionId: string; relationshipTypeId: string }> {
  const definitionId = "019cc7c4-6ed2-7e0a-aed8-e5d451c96bf4";
  const relationshipTypeId = "019cc7c4-6ed2-7e0a-aed8-e5d451c96bf5";
  await fixture.database.insert(factDefinitions).values({
    id: definitionId,
    workspaceId: actor.workspaceId,
    namespace: "import",
    fieldKey: "alias",
    label: "Imported alias",
    allowedValueType: "text",
    cardinality: "many",
    state: "active",
    createdBy: actor.principalId,
    updatedBy: actor.principalId,
  });
  await fixture.database.insert(relationshipTypes).values({
    id: relationshipTypeId,
    workspaceId: actor.workspaceId,
    namespace: "import",
    key: "knows",
    forwardLabel: "knows",
    inverseLabel: "known by",
    directed: true,
    allowsSelf: false,
    allowedMultiplicity: "many_to_many",
    state: "active",
    createdBy: actor.principalId,
    updatedBy: actor.principalId,
  });
  return { definitionId, relationshipTypeId };
}

async function writeImportedNetwork(
  context: ResearchServiceContext,
  definitionId: string,
  relationshipTypeId: string,
): Promise<ResponseReference> {
  const peopleService = createPeopleService(context);
  const factsService = createFactsService(context);
  const relationshipsService = createRelationshipsService(context);
  const ada = await peopleService.create({ displayName: "Imported Ada" });
  const charles = await peopleService.create({
    displayName: "Imported Charles",
  });
  if (!ada.resource || !charles.resource) {
    throw new Error("Expected imported people to be created.");
  }
  const firstFact = await factsService.create({
    personId: ada.resource.id,
    definitionId,
    value: { text: "Enchantress of Numbers" },
  });
  const secondFact = await factsService.create({
    personId: ada.resource.id,
    definitionId,
    value: { text: "Analyst" },
  });
  const relationship = await relationshipsService.create({
    sourcePersonId: ada.resource.id,
    targetPersonId: charles.resource.id,
    relationshipTypeId,
  });
  if (!firstFact.resource || !secondFact.resource || !relationship.resource) {
    throw new Error("Expected the imported graph to be created.");
  }
  return {
    personId: ada.resource.id,
    relatedPersonId: charles.resource.id,
    firstFactId: firstFact.resource.id,
    secondFactId: secondFact.resource.id,
    relationshipId: relationship.resource.id,
  };
}

async function workspaceCounts(fixture: ResearchFixture, workspaceId: string) {
  const tables = [people, facts, relationships, auditEvents, idempotencyKeys];
  return Promise.all(
    tables.map(async (table) => {
      const [row] = await fixture.database
        .select({ value: count() })
        .from(table)
        .where(eq(table.workspaceId, workspaceId));
      return row?.value ?? 0;
    }),
  );
}

liveDescribe("research write transactions", () => {
  let fixture: ResearchFixture;

  beforeAll(() => {
    fixture = new ResearchFixture();
  });
  beforeEach(async () => fixture.reset());
  afterAll(async () => fixture.close());

  it("atomically commits one multi-service write and replays its stored references", async () => {
    const { runIdempotentResearchWrite } = transactionFunctions();
    const actor = await fixture.createActor();
    const context = await serviceContext(fixture, actor);
    const definitions = await installImportDefinitions(fixture, actor);
    const write = vi.fn((scoped: ResearchServiceContext) =>
      writeImportedNetwork(
        scoped,
        definitions.definitionId,
        definitions.relationshipTypeId,
      ),
    );
    const input = derivedInput(context, {
      idempotencyKey: "atomic-replay",
      requestMaterial: { row: 1, sourceHash: "source-a" },
    });

    const committed = await runIdempotentResearchWrite(
      context,
      input,
      IMPORT_WRITE_PERMISSIONS,
      write,
    );
    const replayed = await runIdempotentResearchWrite(
      context,
      input,
      IMPORT_WRITE_PERMISSIONS,
      write,
    );

    expect(committed.replayed).toBe(false);
    expect(replayed).toEqual({
      replayed: true,
      responseReference: committed.responseReference,
    });
    expect(write).toHaveBeenCalledTimes(1);
    expect(await workspaceCounts(fixture, actor.workspaceId)).toEqual([
      2, 2, 1, 5, 1,
    ]);
  });

  it("rolls back every domain row, audit, and idempotency claim on downstream failure", async () => {
    const { runIdempotentResearchWrite } = transactionFunctions();
    const actor = await fixture.createActor();
    const context = await serviceContext(fixture, actor);
    const definitions = await installImportDefinitions(fixture, actor);

    await expect(
      runIdempotentResearchWrite(
        context,
        derivedInput(context, {
          idempotencyKey: "downstream-rollback",
          requestMaterial: { row: 2, sourceHash: "source-b" },
        }),
        IMPORT_WRITE_PERMISSIONS,
        async (scoped) => {
          await writeImportedNetwork(
            scoped,
            definitions.definitionId,
            definitions.relationshipTypeId,
          );
          throw new Error("simulated downstream failure");
        },
      ),
    ).rejects.toThrow("simulated downstream failure");
    expect(await workspaceCounts(fixture, actor.workspaceId)).toEqual([
      0, 0, 0, 0, 0,
    ]);
  });

  it("rejects an empty permission contract before touching the database", async () => {
    const { runIdempotentResearchWrite } = transactionFunctions();
    const actor = await fixture.createActor();
    const context = await serviceContext(fixture, actor, []);
    const write = vi.fn(async () => ({ personId: "unreachable" }));

    await expect(
      runIdempotentResearchWrite(
        context,
        derivedInput(context, {
          idempotencyKey: "empty-permissions",
          requestMaterial: { row: 3 },
        }),
        [],
        write,
      ),
    ).rejects.toMatchObject({ extensions: { code: "FORBIDDEN" } });
    expect(write).not.toHaveBeenCalled();
    expect(await workspaceCounts(fixture, actor.workspaceId)).toEqual([
      0, 0, 0, 0, 0,
    ]);
  });

  it("rejects a reused operation key with a different request hash", async () => {
    const { runIdempotentResearchWrite } = transactionFunctions();
    const actor = await fixture.createActor();
    const context = await serviceContext(fixture, actor);
    const definitions = await installImportDefinitions(fixture, actor);
    const write = vi.fn((scoped: ResearchServiceContext) =>
      writeImportedNetwork(
        scoped,
        definitions.definitionId,
        definitions.relationshipTypeId,
      ),
    );
    const input = derivedInput(context, {
      idempotencyKey: "request-conflict",
      requestMaterial: { executionMode: "commit", row: 4 },
    });
    await runIdempotentResearchWrite(
      context,
      input,
      IMPORT_WRITE_PERMISSIONS,
      write,
    );

    await expect(
      runIdempotentResearchWrite(
        context,
        derivedInput(context, {
          idempotencyKey: "request-conflict",
          requestMaterial: { executionMode: "dry-run", row: 4 },
        }),
        IMPORT_WRITE_PERMISSIONS,
        write,
      ),
    ).rejects.toMatchObject({ extensions: { code: "CONFLICT" } });
    expect(write).toHaveBeenCalledTimes(1);
    expect(await workspaceCounts(fixture, actor.workspaceId)).toEqual([
      2, 2, 1, 5, 1,
    ]);
  });

  it("serializes concurrent retries into one domain write and one audit set", async () => {
    const { runIdempotentResearchWrite } = transactionFunctions();
    const actor = await fixture.createActor();
    const context = await serviceContext(fixture, actor);
    const definitions = await installImportDefinitions(fixture, actor);
    const write = vi.fn((scoped: ResearchServiceContext) =>
      writeImportedNetwork(
        scoped,
        definitions.definitionId,
        definitions.relationshipTypeId,
      ),
    );
    const input = derivedInput(context, {
      idempotencyKey: "concurrent-retry",
      requestMaterial: { row: 5, sourceHash: "source-c" },
    });

    const outcomes = await Promise.all([
      runIdempotentResearchWrite(
        context,
        input,
        IMPORT_WRITE_PERMISSIONS,
        write,
      ),
      runIdempotentResearchWrite(
        context,
        input,
        IMPORT_WRITE_PERMISSIONS,
        write,
      ),
    ]);

    expect(outcomes.map((outcome) => outcome.replayed).sort()).toEqual([
      false,
      true,
    ]);
    expect(outcomes[0]?.responseReference).toEqual(
      outcomes[1]?.responseReference,
    );
    expect(write).toHaveBeenCalledTimes(1);
    expect(await workspaceCounts(fixture, actor.workspaceId)).toEqual([
      2, 2, 1, 5, 1,
    ]);
  });

  it("covers durable fact-create replay, expiry, malformed references, and tenant fencing", async () => {
    const { deriveResearchIdempotency, runIdempotentResearchWrite } =
      hardenedTransactionFunctions();
    const actor = await fixture.createActor();
    const foreign = await fixture.createActor();
    const context = await serviceContext(fixture, actor, [
      "person:create",
      "person:read",
      "fact:create",
    ]);
    const foreignContext = await serviceContext(fixture, foreign, [
      "person:create",
      "person:read",
      "fact:create",
    ]);
    const person = await createPeopleService(context).create({
      displayName: "Idempotent fact subject",
    });
    const foreignPerson = await createPeopleService(foreignContext).create({
      displayName: "Foreign fact subject",
    });
    if (!person.resource || !foreignPerson.resource) {
      throw new Error("The fact idempotency fixture person is missing.");
    }
    const definitionId = newId();
    const foreignDefinitionId = newId();
    await fixture.database.insert(factDefinitions).values([
      {
        id: definitionId,
        workspaceId: actor.workspaceId,
        namespace: "person",
        fieldKey: "idempotent_alias",
        label: "Idempotent alias",
        allowedValueType: "text",
        cardinality: "many",
        state: "active",
        createdBy: actor.principalId,
        updatedBy: actor.principalId,
      },
      {
        id: foreignDefinitionId,
        workspaceId: foreign.workspaceId,
        namespace: "person",
        fieldKey: "idempotent_alias",
        label: "Foreign idempotent alias",
        allowedValueType: "text",
        cardinality: "many",
        state: "active",
        createdBy: foreign.principalId,
        updatedBy: foreign.principalId,
      },
    ]);

    const createFact = vi.fn(async (scoped: ResearchServiceContext) => {
      const result = await createFactsService(scoped).create({
        personId: person.resource!.id,
        definitionId,
        value: { text: "single durable fact" },
      });
      if (!result.resource) throw new Error("The fact was not created.");
      return { factId: result.resource.id };
    });
    const requestMaterial = {
      definitionId,
      personId: person.resource.id,
      value: { text: "single durable fact" },
    } as const;
    const input = derivedInput(context, {
      idempotencyKey: "fact-create-replay",
      operation: "fact.create",
      requestMaterial,
    });

    const first = await runIdempotentResearchWrite(
      context,
      input,
      ["fact:create"],
      createFact,
    );
    const equivalent = deriveResearchIdempotency(context, {
      expiresAt: new Date(Date.now() + 60_000),
      idempotencyKey: " fact-create-replay ",
      operation: "fact.create",
      requestMaterial: {
        value: { text: "single durable fact" },
        personId: person.resource.id,
        definitionId,
      },
      secret: TEST_IDEMPOTENCY_SECRET,
    });
    const replayed = await runIdempotentResearchWrite(
      context,
      equivalent,
      ["fact:create"],
      createFact,
    );
    expect(first.replayed).toBe(false);
    expect(replayed).toEqual({
      replayed: true,
      responseReference: first.responseReference,
    });
    expect(createFact).toHaveBeenCalledTimes(1);

    const firstClaim = (
      await fixture.database
        .select()
        .from(idempotencyKeys)
        .where(eq(idempotencyKeys.workspaceId, actor.workspaceId))
    ).find(
      (claim) =>
        claim.operation === "fact.create" &&
        (claim.responseReference as { factId?: unknown } | null)?.factId ===
          first.responseReference.factId,
    );
    if (!firstClaim) throw new Error("The fact idempotency claim is missing.");
    await fixture.database
      .update(idempotencyKeys)
      .set({ responseReference: { factId: ["invalid"] } })
      .where(eq(idempotencyKeys.id, firstClaim.id));
    await expect(
      runIdempotentResearchWrite(
        context,
        equivalent,
        ["fact:create"],
        createFact,
      ),
    ).rejects.toMatchObject({ extensions: { code: "VALIDATION_FAILED" } });

    const concurrentInput = derivedInput(context, {
      idempotencyKey: "fact-create-concurrent",
      operation: "fact.create",
      requestMaterial: {
        definitionId,
        personId: person.resource.id,
        value: { text: "concurrent fact" },
      },
    });
    const concurrentCreate = vi.fn(async (scoped: ResearchServiceContext) => {
      const result = await createFactsService(scoped).create({
        personId: person.resource!.id,
        definitionId,
        value: { text: "concurrent fact" },
      });
      if (!result.resource) throw new Error("The concurrent fact is missing.");
      return { factId: result.resource.id };
    });
    const concurrent = await Promise.all([
      runIdempotentResearchWrite(
        context,
        concurrentInput,
        ["fact:create"],
        concurrentCreate,
      ),
      runIdempotentResearchWrite(
        context,
        concurrentInput,
        ["fact:create"],
        concurrentCreate,
      ),
    ]);
    expect(concurrent.map((result) => result.replayed).sort()).toEqual([
      false,
      true,
    ]);
    expect(concurrent[0]?.responseReference).toEqual(
      concurrent[1]?.responseReference,
    );
    expect(concurrentCreate).toHaveBeenCalledTimes(1);

    const malformedWrite = vi.fn(async () => ({ factId: "unreachable" }));
    await expect(
      runIdempotentResearchWrite(
        context,
        {
          expiresAt: new Date(Date.now() + 60_000),
          keyHash: "a".repeat(64),
          operation: "fact.create",
          requestHash: "b".repeat(64),
          workspaceId: context.workspaceId,
        } as unknown as DerivedResearchIdempotency,
        ["fact:create"],
        malformedWrite,
      ),
    ).rejects.toMatchObject({ extensions: { code: "VALIDATION_FAILED" } });
    expect(malformedWrite).not.toHaveBeenCalled();

    const expired = derivedInput(context, {
      expiresAt: new Date(Date.now() + 20),
      idempotencyKey: "fact-create-expired",
      operation: "fact.create",
      requestMaterial,
    });
    await new Promise((resolve) => setTimeout(resolve, 40));
    await expect(
      runIdempotentResearchWrite(context, expired, ["fact:create"], createFact),
    ).rejects.toMatchObject({ extensions: { code: "VALIDATION_FAILED" } });

    await expect(
      runIdempotentResearchWrite(
        context,
        derivedInput(context, {
          idempotencyKey: "fact-create-foreign",
          operation: "fact.create",
          requestMaterial: {
            definitionId: foreignDefinitionId,
            personId: foreignPerson.resource.id,
            value: { text: "cross-tenant" },
          },
        }),
        ["fact:create"],
        async (scoped) => {
          const result = await createFactsService(scoped).create({
            personId: foreignPerson.resource!.id,
            definitionId: foreignDefinitionId,
            value: { text: "cross-tenant" },
          });
          return { factId: result.resource?.id ?? null };
        },
      ),
    ).rejects.toMatchObject({ extensions: { code: "NOT_FOUND" } });

    expect(
      await fixture.database
        .select({ id: facts.id })
        .from(facts)
        .where(eq(facts.workspaceId, actor.workspaceId)),
    ).toHaveLength(2);
    expect(
      await fixture.database
        .select({ id: auditEvents.id })
        .from(auditEvents)
        .where(eq(auditEvents.action, "fact.create")),
    ).toHaveLength(2);
    expect(
      await fixture.database
        .select({ id: idempotencyKeys.id })
        .from(idempotencyKeys)
        .where(eq(idempotencyKeys.workspaceId, actor.workspaceId)),
    ).toHaveLength(2);
    expect(
      await fixture.database
        .select({ id: facts.id })
        .from(facts)
        .where(eq(facts.workspaceId, foreign.workspaceId)),
    ).toHaveLength(0);
  });

  it("covers durable person-create replay, expiry, malformed references, and tenant fencing", async () => {
    const actor = await fixture.createActor();
    const foreign = await fixture.createActor();
    const context = await serviceContext(fixture, actor, [
      "person:create",
      "person:read",
    ]);
    const foreignContext = await serviceContext(fixture, foreign, [
      "person:create",
      "person:read",
    ]);
    const peopleService = createPeopleService(context);
    const replayInput = {
      idempotencyKey: "person-create-replay",
      displayName: "Idempotent person",
      biography: "A single durable person row.",
    } as const;

    const first = await peopleService.create(replayInput);
    const replayed = await peopleService.create(replayInput);
    if (!first.resource || !replayed.resource) {
      throw new Error("The person idempotency fixture is missing a resource.");
    }
    expect(replayed.resource.id).toBe(first.resource.id);
    expect(
      await fixture.database
        .select({ id: people.id })
        .from(people)
        .where(eq(people.workspaceId, actor.workspaceId)),
    ).toHaveLength(1);

    const firstClaim = (
      await fixture.database
        .select()
        .from(idempotencyKeys)
        .where(eq(idempotencyKeys.workspaceId, actor.workspaceId))
    ).find(
      (claim) =>
        claim.operation === "person.create" &&
        (claim.responseReference as { personId?: unknown } | null)?.personId ===
          first.resource?.id,
    );
    if (!firstClaim)
      throw new Error("The person idempotency claim is missing.");
    await fixture.database
      .update(idempotencyKeys)
      .set({ responseReference: { personId: ["invalid"] } })
      .where(eq(idempotencyKeys.id, firstClaim.id));
    await expect(peopleService.create(replayInput)).rejects.toMatchObject({
      extensions: { code: "VALIDATION_FAILED" },
    });

    const expiredInput = {
      idempotencyKey: "person-create-expired",
      displayName: "Expired person claim",
    } as const;
    const expiredFirst = await peopleService.create(expiredInput);
    if (!expiredFirst.resource)
      throw new Error("The expired fixture is missing.");
    const expiredClaim = (
      await fixture.database
        .select()
        .from(idempotencyKeys)
        .where(eq(idempotencyKeys.workspaceId, actor.workspaceId))
    ).find(
      (claim) =>
        claim.operation === "person.create" &&
        (claim.responseReference as { personId?: unknown } | null)?.personId ===
          expiredFirst.resource?.id,
    );
    if (!expiredClaim) throw new Error("The expired person claim is missing.");
    await fixture.database
      .update(idempotencyKeys)
      .set({ expiresAt: new Date(Date.now() - 1) })
      .where(eq(idempotencyKeys.id, expiredClaim.id));
    const expiredTakeover = await peopleService.create(expiredInput);
    if (!expiredTakeover.resource)
      throw new Error("The expired claim did not take over.");
    expect(expiredTakeover.resource.id).not.toBe(expiredFirst.resource.id);

    const concurrentInput = {
      idempotencyKey: "person-create-concurrent",
      displayName: "Concurrent person",
    } as const;
    const concurrent = await Promise.all([
      peopleService.create(concurrentInput),
      peopleService.create(concurrentInput),
    ]);
    if (!concurrent[0]?.resource || !concurrent[1]?.resource) {
      throw new Error("The concurrent person fixture is missing a resource.");
    }
    expect(concurrent[0].resource.id).toBe(concurrent[1].resource.id);

    const tenantInput = {
      idempotencyKey: "person-create-tenant-fence",
      displayName: "Tenant-fenced person",
    } as const;
    const localTenant = await peopleService.create(tenantInput);
    const foreignTenant =
      await createPeopleService(foreignContext).create(tenantInput);
    if (!localTenant.resource || !foreignTenant.resource) {
      throw new Error("The tenant fixture is missing a resource.");
    }
    expect(foreignTenant.resource.id).not.toBe(localTenant.resource.id);
    expect(
      await fixture.database
        .select({ id: people.id })
        .from(people)
        .where(eq(people.workspaceId, foreign.workspaceId)),
    ).toHaveLength(1);
    expect(
      await fixture.database
        .select({ id: idempotencyKeys.id })
        .from(idempotencyKeys)
        .where(eq(idempotencyKeys.workspaceId, actor.workspaceId)),
    ).toHaveLength(4);
  });

  it("replays person updates and archives without duplicate domain or audit effects", async () => {
    const actor = await fixture.createActor();
    const context = await serviceContext(fixture, actor, [
      "person:create",
      "person:read",
      "person:update",
      "person:delete",
    ]);
    const peopleService = createPeopleService(context);
    const created = await peopleService.create({
      displayName: "Retryable person",
    });
    if (!created.resource) throw new Error("The person fixture is missing.");

    const updateInput = {
      id: created.resource.id,
      expectedVersion: created.resource.version,
      idempotencyKey: "person-update-replay",
      displayName: "Retryable person, updated",
      biography: "The update is safe to retry.",
    } as const;
    const firstUpdate = await peopleService.update(updateInput);
    const replayedUpdate = await peopleService.update(updateInput);
    expect(firstUpdate.resource?.id).toBe(created.resource.id);
    expect(replayedUpdate.resource).toMatchObject({
      id: created.resource.id,
      displayName: "Retryable person, updated",
      biography: "The update is safe to retry.",
      version: created.resource.version + 1,
    });
    await expect(
      peopleService.update({ ...updateInput, biography: null }),
    ).rejects.toMatchObject({ extensions: { code: "CONFLICT" } });
    const updateClaim = (
      await fixture.database
        .select()
        .from(idempotencyKeys)
        .where(eq(idempotencyKeys.workspaceId, actor.workspaceId))
    ).find((claim) => claim.operation === "person.update");
    if (!updateClaim) throw new Error("The person update claim is missing.");
    await fixture.database
      .update(idempotencyKeys)
      .set({ responseReference: { personId: created.resource.id } })
      .where(eq(idempotencyKeys.id, updateClaim.id));
    await expect(peopleService.update(updateInput)).rejects.toMatchObject({
      extensions: { code: "VALIDATION_FAILED" },
    });
    expect(
      await fixture.database
        .select({ id: auditEvents.id })
        .from(auditEvents)
        .where(
          and(
            eq(auditEvents.workspaceId, actor.workspaceId),
            eq(auditEvents.action, "person.update"),
            eq(auditEvents.resourceId, created.resource.id),
          ),
        ),
    ).toHaveLength(1);

    const archiveInput = {
      id: created.resource.id,
      expectedVersion: created.resource.version + 1,
      idempotencyKey: "person-archive-replay",
    } as const;
    const firstArchive = await peopleService.archive(archiveInput);
    const replayedArchive = await peopleService.archive(archiveInput);
    expect(firstArchive.resource).toMatchObject({
      id: created.resource.id,
      status: "archived",
      version: created.resource.version + 2,
    });
    expect(replayedArchive.resource).toMatchObject({
      id: created.resource.id,
      status: "archived",
      version: created.resource.version + 2,
    });
    await expect(
      peopleService.archive({
        ...archiveInput,
        idempotencyKey: "person-archive-new-key",
      }),
    ).rejects.toMatchObject({ extensions: { code: "CONFLICT" } });
    expect(
      await fixture.database
        .select({ id: auditEvents.id })
        .from(auditEvents)
        .where(
          and(
            eq(auditEvents.workspaceId, actor.workspaceId),
            eq(auditEvents.action, "person.archive"),
            eq(auditEvents.resourceId, created.resource.id),
          ),
        ),
    ).toHaveLength(1);
    expect(
      await fixture.database
        .select({ id: idempotencyKeys.id })
        .from(idempotencyKeys)
        .where(eq(idempotencyKeys.workspaceId, actor.workspaceId)),
    ).toHaveLength(2);
  });

  it("fences person mutation idempotency keys to the principal and workspace", async () => {
    const actor = await fixture.createActor();
    const foreign = await fixture.createActor();
    const context = await serviceContext(fixture, actor, [
      "person:create",
      "person:read",
      "person:update",
    ]);
    const foreignContext = await serviceContext(fixture, foreign, [
      "person:create",
      "person:read",
      "person:update",
    ]);
    const peopleService = createPeopleService(context);
    const foreignPeopleService = createPeopleService(foreignContext);
    const person = await peopleService.create({ displayName: "Private retry" });
    const foreignPerson = await foreignPeopleService.create({
      displayName: "Foreign retry",
    });
    if (!person.resource || !foreignPerson.resource) {
      throw new Error("The tenant fencing fixtures are missing.");
    }
    const input = {
      id: person.resource.id,
      expectedVersion: person.resource.version,
      idempotencyKey: "same-person-update-key",
      displayName: "Private retry, changed",
    } as const;
    await peopleService.update(input);
    await expect(
      foreignPeopleService.update({
        ...input,
        id: foreignPerson.resource.id,
      }),
    ).resolves.toMatchObject({
      resource: {
        id: foreignPerson.resource.id,
        displayName: "Private retry, changed",
        version: foreignPerson.resource.version + 1,
      },
    });
    await expect(
      foreignPeopleService.update({
        ...input,
        id: person.resource.id,
      }),
    ).rejects.toMatchObject({ extensions: { code: "NOT_FOUND" } });
    expect(
      await fixture.database
        .select({ id: people.id })
        .from(people)
        .where(eq(people.workspaceId, actor.workspaceId)),
    ).toHaveLength(1);
  });

  it("rejects invalid live audit attribution before a composed write", async () => {
    const { runResearchTransaction } = transactionFunctions();
    const actor = await fixture.createActor();
    const context = await serviceContext(fixture, actor);
    if (context.actor.type !== "user")
      throw new Error("Expected a user actor.");
    const invalidAuditContext: ResearchServiceContext = {
      ...context,
      actor: { ...context.actor, sessionId: "missing-session" },
    };

    await expect(
      runResearchTransaction(
        invalidAuditContext,
        { requiredPermissions: ["person:create"] },
        async (scoped) => {
          const result = await createPeopleService(scoped).create({
            displayName: "Must Roll Back",
          });
          return result.resource?.id ?? null;
        },
      ),
    ).rejects.toMatchObject({ extensions: { code: "FORBIDDEN" } });
    expect(await workspaceCounts(fixture, actor.workspaceId)).toEqual([
      0, 0, 0, 0, 0,
    ]);
  });

  it("fails closed when a composed fact write targets another workspace", async () => {
    const { runIdempotentResearchWrite } = transactionFunctions();
    const actor = await fixture.createActor();
    const foreign = await fixture.createActor();
    const context = await serviceContext(fixture, actor);
    const { definitionId } = await installImportDefinitions(fixture, actor);
    const foreignPerson = await fixture.createPerson(foreign, {
      displayName: "Foreign Person",
    });
    const foreignPersonId = foreignPerson.body?.data?.createPerson?.person?.id;
    if (!foreignPersonId) throw new Error("Expected a foreign fixture person.");

    await expect(
      runIdempotentResearchWrite(
        context,
        derivedInput(context, {
          idempotencyKey: "cross-workspace-fact",
          requestMaterial: { personId: foreignPersonId },
        }),
        ["fact:create"],
        async (scoped) => {
          const result = await createFactsService(scoped).create({
            personId: foreignPersonId,
            definitionId,
            value: { text: "Must remain tenant scoped" },
          });
          return { factId: result.resource?.id ?? null };
        },
      ),
    ).rejects.toMatchObject({ extensions: { code: "NOT_FOUND" } });
    expect(await workspaceCounts(fixture, actor.workspaceId)).toEqual([
      0, 0, 0, 0, 0,
    ]);
  });

  it("does not issue a nested transaction savepoint and preserves standalone writes", async () => {
    const { runIdempotentResearchWrite } = transactionFunctions();
    const actor = await fixture.createActor();
    const baseContext = await serviceContext(fixture, actor);
    const definitions = await installImportDefinitions(fixture, actor);
    const statements: string[] = [];
    const connection = createTestConnection(4, (_connection, query) =>
      statements.push(query),
    );
    const database = createTestDatabase(connection);
    const context: ResearchServiceContext = { ...baseContext, database };
    try {
      await runIdempotentResearchWrite(
        context,
        derivedInput(context, {
          idempotencyKey: "no-savepoints",
          requestMaterial: { row: 6, sourceHash: "source-d" },
        }),
        IMPORT_WRITE_PERMISSIONS,
        (scoped) =>
          writeImportedNetwork(
            scoped,
            definitions.definitionId,
            definitions.relationshipTypeId,
          ),
      );
      const standalone = await createPeopleService(context).create({
        displayName: "Standalone Person",
      });
      expect(standalone).toMatchObject({
        code: null,
        issues: [],
        resource: { displayName: "Standalone Person" },
      });
    } finally {
      await connection.end();
    }

    expect(statements.some((statement) => /savepoint/iu.test(statement))).toBe(
      false,
    );
    expect(
      statements.filter((statement) => /^begin\b/iu.test(statement.trim())),
    ).toHaveLength(2);
    expect(await workspaceCounts(fixture, actor.workspaceId)).toEqual([
      3, 2, 1, 6, 1,
    ]);
  });

  it("keeps idempotent writes session-only before database access", async () => {
    const { runIdempotentResearchWrite } = transactionFunctions();
    const database = new Proxy(
      {},
      {
        get() {
          throw new Error("database must not be accessed");
        },
      },
    ) as Database;
    const context: ResearchServiceContext = {
      actor: {
        type: "apiKey",
        id: "key-fixture",
        principalId: "019cc7c4-6ed2-7e0a-aed8-e5d451c96bf6",
        role: null,
      },
      database,
      permissions: new Set(["person:create"]),
      requestId: "019cc7c4-6ed2-7e0a-aed8-e5d451c96bf7",
      searchIndexMaintenance: disabledSearchIndexMaintenance,
      workspaceId: "019cc7c4-6ed2-7e0a-aed8-e5d451c96bf8",
    };

    await expect(
      runIdempotentResearchWrite(
        context,
        {} as DerivedResearchIdempotency,
        ["person:create"],
        async () => ({ personId: "unreachable" }),
      ),
    ).rejects.toMatchObject({ extensions: { code: "FORBIDDEN" } });
  });

  it("rejects non-canonical permission contracts before database access", async () => {
    const { runResearchTransaction } = transactionFunctions();
    const database = new Proxy(
      {},
      {
        get() {
          throw new Error("database must not be accessed");
        },
      },
    ) as Database;
    const apiKeyContext: ResearchServiceContext = {
      actor: {
        type: "apiKey",
        id: "key-fixture",
        principalId: "019cc7c4-6ed2-7e0a-aed8-e5d451c96bf6",
        role: null,
      },
      database,
      permissions: new Set(["person:create", "unknown:create"]),
      requestId: "019cc7c4-6ed2-7e0a-aed8-e5d451c96bf7",
      searchIndexMaintenance: disabledSearchIndexMaintenance,
      workspaceId: "019cc7c4-6ed2-7e0a-aed8-e5d451c96bf8",
    };
    const write = vi.fn(async () => "unreachable");

    for (const requiredPermissions of [
      [],
      ["person:create", "person:create"],
      ["unknown:create"],
    ]) {
      await expect(
        runResearchTransaction(
          {
            ...apiKeyContext,
            actor: {
              type: "user",
              id: "user-fixture",
              principalId: "019cc7c4-6ed2-7e0a-aed8-e5d451c96bf6",
              sessionId: "session-fixture",
              memberId: "member-fixture",
              role: "owner",
            },
          },
          { requiredPermissions },
          write,
        ),
      ).rejects.toMatchObject({ extensions: { code: "FORBIDDEN" } });
    }
    expect(write).not.toHaveBeenCalled();
  });

  it("revalidates the exact live session tuple and canonical role authority inside the transaction", async () => {
    const { runResearchTransaction } = transactionFunctions();
    const viewer = await fixture.createActor("viewer");
    const viewerContext = await serviceContext(fixture, viewer, [
      "person:create",
    ]);
    if (viewerContext.actor.type !== "user") {
      throw new Error("Expected a user actor.");
    }
    const write = vi.fn(async () => "unreachable");

    await expect(
      runResearchTransaction(
        {
          ...viewerContext,
          actor: { ...viewerContext.actor, role: "viewer" },
        },
        { requiredPermissions: ["person:create"] },
        write,
      ),
    ).rejects.toMatchObject({ extensions: { code: "FORBIDDEN" } });
    expect(write).not.toHaveBeenCalled();

    const owner = await fixture.createActor();
    const ownerContext = await serviceContext(fixture, owner);
    await fixture.database
      .update(sessions)
      .set({ expiresAt: new Date(Date.now() - 1_000) })
      .where(eq(sessions.userId, owner.userId));

    await expect(
      runResearchTransaction(
        ownerContext,
        { requiredPermissions: ["person:create"] },
        write,
      ),
    ).rejects.toMatchObject({ extensions: { code: "FORBIDDEN" } });
    expect(write).not.toHaveBeenCalled();

    const secondOwner = await fixture.createActor();
    const secondOwnerContext = await serviceContext(fixture, secondOwner);
    if (secondOwnerContext.actor.type !== "user") {
      throw new Error("Expected a user actor.");
    }
    const invalidContexts: ResearchServiceContext[] = [
      {
        ...secondOwnerContext,
        actor: {
          ...secondOwnerContext.actor,
          id: "missing-user",
        },
      },
      {
        ...secondOwnerContext,
        actor: {
          ...secondOwnerContext.actor,
          memberId: "missing-member",
        },
      },
      {
        ...secondOwnerContext,
        actor: {
          ...secondOwnerContext.actor,
          principalId: "019cc7c4-6ed2-7e0a-aed8-e5d451c96bf9",
        },
      },
      {
        ...secondOwnerContext,
        workspaceId: owner.workspaceId,
      },
    ];
    for (const invalidContext of invalidContexts) {
      await expect(
        runResearchTransaction(
          invalidContext,
          { requiredPermissions: ["person:create"] },
          write,
        ),
      ).rejects.toMatchObject({ extensions: { code: "FORBIDDEN" } });
    }
    expect(write).not.toHaveBeenCalled();

    await fixture.database
      .update(sessions)
      .set({ expiresAt: new Date(Date.now() + 60_000) })
      .where(eq(sessions.userId, owner.userId));
    await fixture.database
      .update(members)
      .set({ role: "admin" })
      .where(eq(members.id, owner.memberId));

    await expect(
      runResearchTransaction(
        ownerContext,
        { requiredPermissions: ["person:create"] },
        write,
      ),
    ).rejects.toMatchObject({ extensions: { code: "FORBIDDEN" } });
    expect(write).not.toHaveBeenCalled();
  });

  it("accepts a current re-invited membership with its existing durable principal", async () => {
    const { runResearchTransaction } = transactionFunctions();
    const actor = await fixture.createActor();
    const originalContext = await serviceContext(fixture, actor);
    if (originalContext.actor.type !== "user") {
      throw new Error("Expected a user actor.");
    }
    const rejoinedMemberId = "rejoined-member-fixture";
    await fixture.database
      .delete(members)
      .where(eq(members.id, actor.memberId));
    await fixture.database.insert(members).values({
      id: rejoinedMemberId,
      organizationId: actor.organizationId,
      userId: actor.userId,
      role: "owner",
      createdAt: new Date(),
      workspaceId: actor.workspaceId,
    });
    const durablePrincipalId = await ensureUserPrincipal(fixture.database, {
      memberId: rejoinedMemberId,
      userId: actor.userId,
      workspaceId: actor.workspaceId,
    });
    expect(durablePrincipalId).toBe(actor.principalId);

    const result = await runResearchTransaction(
      {
        ...originalContext,
        actor: {
          ...originalContext.actor,
          memberId: rejoinedMemberId,
        },
      },
      { requiredPermissions: ["person:create"] },
      async (scoped) =>
        createPeopleService(scoped).create({ displayName: "Rejoined User" }),
    );

    expect(result).toMatchObject({
      code: null,
      issues: [],
      resource: { displayName: "Rejoined User" },
    });
    expect(await workspaceCounts(fixture, actor.workspaceId)).toEqual([
      1, 0, 0, 1, 0,
    ]);
  });

  it("retires escaped transaction contexts and never reuses their closed database", async () => {
    const { runResearchTransaction } = transactionFunctions();
    const actor = await fixture.createActor();
    const context = await serviceContext(fixture, actor);
    let escapedContext: ResearchServiceContext | undefined;
    await runResearchTransaction(
      context,
      { requiredPermissions: ["person:create"] },
      async (scoped) => {
        escapedContext = scoped;
      },
    );
    if (!escapedContext) throw new Error("Expected a scoped context.");
    const escapedWrite = vi.fn(async () => "unreachable");

    await expect(
      runResearchTransaction(
        escapedContext,
        { requiredPermissions: ["person:create"] },
        escapedWrite,
      ),
    ).rejects.toMatchObject({ extensions: { code: "PRECONDITION_FAILED" } });
    await expect(
      createPeopleService(escapedContext).create({
        displayName: "Must Not Escape",
      }),
    ).rejects.toMatchObject({ extensions: { code: "PRECONDITION_FAILED" } });
    expect(escapedWrite).not.toHaveBeenCalled();
    expect(await workspaceCounts(fixture, actor.workspaceId)).toEqual([
      0, 0, 0, 0, 0,
    ]);

    let rejectedContext: ResearchServiceContext | undefined;
    await expect(
      runResearchTransaction(
        context,
        { requiredPermissions: ["person:create"] },
        async (scoped) => {
          rejectedContext = scoped;
          throw new Error("expected callback rejection");
        },
      ),
    ).rejects.toThrow("expected callback rejection");
    if (!rejectedContext) throw new Error("Expected a rejected context.");
    await expect(
      createPeopleService(rejectedContext).create({
        displayName: "Rejected Context Must Not Escape",
      }),
    ).rejects.toMatchObject({ extensions: { code: "PRECONDITION_FAILED" } });
  });

  it("rejects caught nested idempotent writes before ledger or domain access", async () => {
    const { runIdempotentResearchWrite, runResearchTransaction } =
      transactionFunctions();
    const actor = await fixture.createActor();
    const context = await serviceContext(fixture, actor);
    const nestedInput = derivedInput(context, {
      idempotencyKey: "nested-write",
      requestMaterial: { row: 7, sourceHash: "source-e" },
    });
    const write = vi.fn(async (scoped: ResearchServiceContext) => {
      const result = await createPeopleService(scoped).create({
        displayName: "Nested Partial Write",
      });
      return { personId: result.resource?.id ?? null };
    });
    let nestedError: unknown;

    await runResearchTransaction(
      context,
      { requiredPermissions: ["person:create"] },
      async (scoped) => {
        try {
          await runIdempotentResearchWrite(
            scoped,
            nestedInput,
            ["person:create"],
            write,
          );
        } catch (error) {
          nestedError = error;
        }
      },
    );

    expect(nestedError).toMatchObject({
      extensions: { code: "PRECONDITION_FAILED" },
    });
    expect(write).not.toHaveBeenCalled();
    expect(await workspaceCounts(fixture, actor.workspaceId)).toEqual([
      0, 0, 0, 0, 0,
    ]);
  });

  it("derives opaque deterministic HMAC metadata from normalized keys and canonical requests", async () => {
    const { deriveResearchIdempotency, runIdempotentResearchWrite } =
      hardenedTransactionFunctions();
    const actor = await fixture.createActor();
    const context = await serviceContext(fixture, actor);
    const expiresAt = new Date(Date.now() + 60_000);
    const secret = "42".repeat(32);
    const derive = (
      idempotencyKey: string,
      requestMaterial: Readonly<Record<string, CanonicalRequestMaterial>>,
    ) =>
      deriveResearchIdempotency(context, {
        expiresAt,
        idempotencyKey,
        operation: "import.row.commit",
        requestMaterial,
        secret,
      });
    const first = derive("  import-row-42  ", {
      executionMode: "commit",
      file: { checksum: "sha256:fixture", size: 42 },
      mapping: { hash: "mapping-hash", id: "mapping-id", version: 3 },
    });
    const equivalent = derive("import-row-42", {
      mapping: { version: 3, id: "mapping-id", hash: "mapping-hash" },
      file: { size: 42, checksum: "sha256:fixture" },
      executionMode: "commit",
    });
    const different = derive("import-row-42", {
      executionMode: "dry-run",
      file: { checksum: "sha256:fixture", size: 42 },
      mapping: { hash: "mapping-hash", id: "mapping-id", version: 3 },
    });
    const write = vi.fn(async () => ({ importId: "import-fixture" }));

    expect(Object.keys(first)).toEqual([]);
    expect(JSON.stringify(first)).toBe("{}");

    const committed = await runIdempotentResearchWrite(
      context,
      first,
      ["person:create"],
      write,
    );
    const replayed = await runIdempotentResearchWrite(
      context,
      equivalent,
      ["person:create"],
      write,
    );
    expect(committed.replayed).toBe(false);
    expect(replayed).toEqual({
      replayed: true,
      responseReference: committed.responseReference,
    });
    await expect(
      runIdempotentResearchWrite(context, different, ["person:create"], write),
    ).rejects.toMatchObject({ extensions: { code: "CONFLICT" } });
    expect(write).toHaveBeenCalledTimes(1);

    const [stored] = await fixture.database
      .select({
        keyHash: idempotencyKeys.keyHash,
        requestHash: idempotencyKeys.requestHash,
      })
      .from(idempotencyKeys)
      .where(eq(idempotencyKeys.workspaceId, actor.workspaceId));
    expect(stored).toMatchObject({
      keyHash: expect.stringMatching(/^[0-9a-f]{64}$/u),
      requestHash: expect.stringMatching(/^[0-9a-f]{64}$/u),
    });
    expect(stored?.keyHash).not.toContain("import-row-42");

    await expect(
      runIdempotentResearchWrite(
        context,
        {
          expiresAt,
          keyHash: "c5".repeat(32),
          operation: "import.row.commit",
          requestHash: "d6".repeat(32),
          requiredPermissions: ["person:create"],
        } as unknown as DerivedResearchIdempotency,
        ["person:create"],
        write,
      ),
    ).rejects.toMatchObject({ extensions: { code: "VALIDATION_FAILED" } });
    for (const invalidInput of [
      { idempotencyKey: "", secret },
      { idempotencyKey: "x".repeat(129), secret },
      { idempotencyKey: "key", secret: "not-a-secret" },
    ]) {
      expect(() =>
        deriveResearchIdempotency(context, {
          expiresAt,
          operation: "import.row.commit",
          requestMaterial: { executionMode: "commit" },
          ...invalidInput,
        }),
      ).toThrow();
    }
  });

  it("moves person tags and fences identity candidates across reversible merges", async () => {
    const actor = await fixture.createActor();
    const context = await serviceContext(fixture, actor, [
      "person:create",
      "person:read",
      "person:merge",
    ]);
    const peopleService = createPeopleService(context);
    const winner = await peopleService.create({ displayName: "Winner" });
    const loser = await peopleService.create({ displayName: "Loser" });
    expect(winner.resource?.id).toBeTruthy();
    expect(loser.resource?.id).toBeTruthy();
    const tagId = "019cc7c4-6ed2-7e0a-aed8-e5d451c96bf6";
    const tagLinkId = "019cc7c4-6ed2-7e0a-aed8-e5d451c96bf7";
    const candidateId = "019cc7c4-6ed2-7e0a-aed8-e5d451c96bf8";
    await fixture.database.insert(tags).values({
      id: tagId,
      workspaceId: actor.workspaceId,
      name: "Research",
      normalizedName: "research",
      createdBy: actor.principalId,
      updatedBy: actor.principalId,
    });
    await fixture.database.insert(personTags).values({
      id: tagLinkId,
      workspaceId: actor.workspaceId,
      personId: loser.resource!.id,
      tagId,
      createdBy: actor.principalId,
    });
    await fixture.database.insert(identityCandidates).values({
      id: candidateId,
      workspaceId: actor.workspaceId,
      firstPersonId: loser.resource!.id,
      secondPersonId: winner.resource!.id,
      score: "0.900",
      createdBy: actor.principalId,
      updatedBy: actor.principalId,
    });

    const merged = await peopleService.merge({
      winnerPersonId: winner.resource!.id,
      loserPersonId: loser.resource!.id,
      reason: "same verified identity",
    });
    expect(merged.resource?.id).toBe(winner.resource!.id);
    const [movedTag] = await fixture.database
      .select({ personId: personTags.personId })
      .from(personTags)
      .where(eq(personTags.id, tagLinkId));
    const [cancelledCandidate] = await fixture.database
      .select({ state: identityCandidates.state })
      .from(identityCandidates)
      .where(eq(identityCandidates.id, candidateId));
    expect(movedTag?.personId).toBe(winner.resource!.id);
    expect(cancelledCandidate?.state).toBe("cancelled");

    const [mergedLoser] = await fixture.database
      .select({ version: people.version })
      .from(people)
      .where(eq(people.id, loser.resource!.id));
    const restored = await peopleService.unmerge({
      loserPersonId: loser.resource!.id,
      expectedVersion: mergedLoser!.version,
    });
    expect(restored.resource?.id).toBe(loser.resource!.id);
    const [restoredTag] = await fixture.database
      .select({ personId: personTags.personId })
      .from(personTags)
      .where(eq(personTags.id, tagLinkId));
    const [restoredCandidate] = await fixture.database
      .select({ state: identityCandidates.state })
      .from(identityCandidates)
      .where(eq(identityCandidates.id, candidateId));
    expect(restoredTag?.personId).toBe(loser.resource!.id);
    expect(restoredCandidate?.state).toBe("pending");
  });

  it("preserves colliding tags and restores external ownership after a fenced merge", async () => {
    const actor = await fixture.createActor();
    const foreign = await fixture.createActor();
    const context = await serviceContext(fixture, actor, [
      "person:create",
      "person:read",
      "person:merge",
    ]);
    const peopleService = createPeopleService(context);
    const winner = await peopleService.create({
      displayName: "Collision Winner",
    });
    const loser = await peopleService.create({
      displayName: "Collision Loser",
    });
    if (!winner.resource || !loser.resource) {
      throw new Error("Expected reconciliation people to be created.");
    }

    const sharedTagId = "019cc7c4-6ed2-7e0a-aed8-e5d451c96c01";
    const loserOnlyTagId = "019cc7c4-6ed2-7e0a-aed8-e5d451c96c02";
    const winnerSharedTagLinkId = "019cc7c4-6ed2-7e0a-aed8-e5d451c96c03";
    const loserSharedTagLinkId = "019cc7c4-6ed2-7e0a-aed8-e5d451c96c04";
    const loserOnlyTagLinkId = "019cc7c4-6ed2-7e0a-aed8-e5d451c96c05";
    const externalRecordId = "019cc7c4-6ed2-7e0a-aed8-e5d451c96c06";
    const candidateId = "019cc7c4-6ed2-7e0a-aed8-e5d451c96c07";
    await fixture.database.insert(tags).values([
      {
        id: sharedTagId,
        workspaceId: actor.workspaceId,
        name: "Shared reconciliation tag",
        normalizedName: "shared-reconciliation-tag",
        createdBy: actor.principalId,
        updatedBy: actor.principalId,
      },
      {
        id: loserOnlyTagId,
        workspaceId: actor.workspaceId,
        name: "Loser-only reconciliation tag",
        normalizedName: "loser-only-reconciliation-tag",
        createdBy: actor.principalId,
        updatedBy: actor.principalId,
      },
    ]);
    await fixture.database.insert(personTags).values([
      {
        id: winnerSharedTagLinkId,
        workspaceId: actor.workspaceId,
        personId: winner.resource.id,
        tagId: sharedTagId,
        createdBy: actor.principalId,
      },
      {
        id: loserSharedTagLinkId,
        workspaceId: actor.workspaceId,
        personId: loser.resource.id,
        tagId: sharedTagId,
        createdBy: actor.principalId,
      },
      {
        id: loserOnlyTagLinkId,
        workspaceId: actor.workspaceId,
        personId: loser.resource.id,
        tagId: loserOnlyTagId,
        createdBy: actor.principalId,
      },
    ]);
    await fixture.database.insert(externalRecords).values({
      id: externalRecordId,
      workspaceId: actor.workspaceId,
      sourceSystem: "reconciliation-test",
      externalType: "person",
      externalId: "collision-loser",
      personId: loser.resource.id,
      lastSeenAt: new Date(),
      createdBy: actor.principalId,
      updatedBy: actor.principalId,
    });
    await fixture.database.insert(identityCandidates).values({
      id: candidateId,
      workspaceId: actor.workspaceId,
      firstPersonId: loser.resource.id,
      secondPersonId: winner.resource.id,
      score: "0.910",
      state: "reviewing",
      reviewReason: "operator-review",
      createdBy: actor.principalId,
      updatedBy: actor.principalId,
    });

    await expect(
      createPeopleService(
        await serviceContext(fixture, foreign, ["person:merge"]),
      ).merge({
        winnerPersonId: winner.resource.id,
        loserPersonId: loser.resource.id,
        reason: "must remain isolated",
      }),
    ).rejects.toMatchObject({ extensions: { code: "NOT_FOUND" } });

    await peopleService.merge({
      winnerPersonId: winner.resource.id,
      loserPersonId: loser.resource.id,
      reason: "same verified identity",
    });

    const [
      mergedLoser,
      mergedSharedLink,
      movedLoserOnlyLink,
      movedExternal,
      fencedCandidate,
    ] = await Promise.all([
      fixture.database
        .select({
          status: people.status,
          mergedIntoPersonId: people.mergedIntoPersonId,
          version: people.version,
        })
        .from(people)
        .where(eq(people.id, loser.resource.id)),
      fixture.database
        .select({ personId: personTags.personId })
        .from(personTags)
        .where(eq(personTags.id, loserSharedTagLinkId)),
      fixture.database
        .select({ personId: personTags.personId })
        .from(personTags)
        .where(eq(personTags.id, loserOnlyTagLinkId)),
      fixture.database
        .select({ personId: externalRecords.personId })
        .from(externalRecords)
        .where(eq(externalRecords.id, externalRecordId)),
      fixture.database
        .select({ state: identityCandidates.state })
        .from(identityCandidates)
        .where(eq(identityCandidates.id, candidateId)),
    ]);
    expect(mergedLoser[0]).toMatchObject({
      status: "merged",
      mergedIntoPersonId: winner.resource.id,
    });
    expect(mergedSharedLink[0]?.personId).toBe(loser.resource.id);
    expect(movedLoserOnlyLink[0]?.personId).toBe(winner.resource.id);
    expect(movedExternal[0]?.personId).toBe(winner.resource.id);
    expect(fencedCandidate[0]?.state).toBe("cancelled");

    const restored = await peopleService.unmerge({
      loserPersonId: loser.resource.id,
      expectedVersion: mergedLoser[0]!.version,
    });
    expect(restored.resource?.id).toBe(loser.resource.id);
    const [
      restoredLoser,
      restoredSharedLink,
      restoredLoserOnlyLink,
      restoredExternal,
      restoredCandidate,
    ] = await Promise.all([
      fixture.database
        .select({
          status: people.status,
          mergedIntoPersonId: people.mergedIntoPersonId,
        })
        .from(people)
        .where(eq(people.id, loser.resource.id)),
      fixture.database
        .select({ personId: personTags.personId })
        .from(personTags)
        .where(eq(personTags.id, loserSharedTagLinkId)),
      fixture.database
        .select({ personId: personTags.personId })
        .from(personTags)
        .where(eq(personTags.id, loserOnlyTagLinkId)),
      fixture.database
        .select({ personId: externalRecords.personId })
        .from(externalRecords)
        .where(eq(externalRecords.id, externalRecordId)),
      fixture.database
        .select({
          state: identityCandidates.state,
          reviewReason: identityCandidates.reviewReason,
        })
        .from(identityCandidates)
        .where(eq(identityCandidates.id, candidateId)),
    ]);
    expect(restoredLoser[0]).toMatchObject({
      status: "active",
      mergedIntoPersonId: null,
    });
    expect(restoredSharedLink[0]?.personId).toBe(loser.resource.id);
    expect(restoredLoserOnlyLink[0]?.personId).toBe(loser.resource.id);
    expect(restoredExternal[0]?.personId).toBe(loser.resource.id);
    expect(restoredCandidate[0]).toMatchObject({
      state: "reviewing",
      reviewReason: "operator-review",
    });
  });

  it("lists and reviews identity candidates inside one workspace with optimistic conflict fencing", async () => {
    const actor = await fixture.createActor();
    const foreign = await fixture.createActor();
    const context = await serviceContext(fixture, actor, [
      "person:create",
      "person:read",
      "person:merge",
    ]);
    const foreignContext = await serviceContext(fixture, foreign, [
      "person:create",
      "person:read",
      "person:merge",
    ]);
    const peopleService = createPeopleService(context);
    const foreignPeopleService = createPeopleService(foreignContext);
    const first = await peopleService.create({ displayName: "Candidate One" });
    const second = await peopleService.create({ displayName: "Candidate Two" });
    const foreignFirst = await foreignPeopleService.create({
      displayName: "Foreign Candidate One",
    });
    const foreignSecond = await foreignPeopleService.create({
      displayName: "Foreign Candidate Two",
    });
    if (
      !first.resource ||
      !second.resource ||
      !foreignFirst.resource ||
      !foreignSecond.resource
    ) {
      throw new Error("Expected identity-candidate people to be created.");
    }

    const candidateId = "019cc7c4-6ed2-7e0a-aed8-e5d451c96d11";
    const foreignCandidateId = "019cc7c4-6ed2-7e0a-aed8-e5d451c96d12";
    await fixture.database.insert(identityCandidates).values([
      {
        id: candidateId,
        workspaceId: actor.workspaceId,
        firstPersonId: first.resource.id,
        secondPersonId: second.resource.id,
        matchSignals: {
          exactIdentifier: true,
          sharedName: true,
          sourceCount: 2,
        },
        score: "0.875",
        createdBy: actor.principalId,
        updatedBy: actor.principalId,
      },
      {
        id: foreignCandidateId,
        workspaceId: foreign.workspaceId,
        firstPersonId: foreignFirst.resource.id,
        secondPersonId: foreignSecond.resource.id,
        matchSignals: { sharedName: true },
        score: "0.990",
        createdBy: foreign.principalId,
        updatedBy: foreign.principalId,
      },
    ]);

    const visible = await peopleService.listIdentityCandidates({ limit: 10 });
    expect(visible).toHaveLength(1);
    expect(visible[0]).toMatchObject({
      id: candidateId,
      firstPersonId: first.resource.id,
      secondPersonId: second.resource.id,
      score: "0.875",
      state: "pending",
      matchSignals: {
        exactIdentifier: true,
        sharedName: true,
        sourceCount: 2,
      },
    });

    const reviewed = await peopleService.reviewIdentityCandidate({
      id: candidateId,
      expectedVersion: 1,
      state: "accepted",
      reason: "Two independent identifiers agree.",
    });
    expect(reviewed).toMatchObject({
      id: candidateId,
      state: "accepted",
      reviewReason: "Two independent identifiers agree.",
      version: 2,
      reviewedBy: actor.principalId,
    });

    await expect(
      peopleService.reviewIdentityCandidate({
        id: candidateId,
        expectedVersion: 1,
        state: "rejected",
        reason: "Stale review must not overwrite the accepted decision.",
      }),
    ).rejects.toMatchObject({ extensions: { code: "CONFLICT" } });

    const afterConflict = await peopleService.listIdentityCandidates();
    expect(afterConflict[0]).toMatchObject({
      id: candidateId,
      state: "accepted",
      reviewReason: "Two independent identifiers agree.",
      version: 2,
    });

    const foreignVisible = await foreignPeopleService.listIdentityCandidates({
      limit: 10,
    });
    expect(foreignVisible).toHaveLength(1);
    expect(foreignVisible[0]?.id).toBe(foreignCandidateId);
    await expect(
      foreignPeopleService.reviewIdentityCandidate({
        id: candidateId,
        expectedVersion: 2,
        state: "rejected",
      }),
    ).rejects.toMatchObject({ extensions: { code: "CONFLICT" } });
  });

  it("fences repeated merge and unmerge attempts without changing the restored ownership", async () => {
    const actor = await fixture.createActor();
    const context = await serviceContext(fixture, actor, [
      "person:create",
      "person:read",
      "person:merge",
    ]);
    const peopleService = createPeopleService(context);
    const winner = await peopleService.create({ displayName: "Stable Winner" });
    const loser = await peopleService.create({ displayName: "Stable Loser" });
    if (!winner.resource || !loser.resource) {
      throw new Error("Expected merge-conflict people to be created.");
    }

    const merged = await peopleService.merge({
      winnerPersonId: winner.resource.id,
      loserPersonId: loser.resource.id,
      reason: "Conflict matrix merge.",
    });
    expect(merged.resource?.id).toBe(winner.resource.id);
    const [mergedRow] = await fixture.database
      .select({ status: people.status, version: people.version })
      .from(people)
      .where(eq(people.id, loser.resource.id));
    expect(mergedRow).toMatchObject({ status: "merged", version: 2 });

    await expect(
      peopleService.merge({
        winnerPersonId: winner.resource.id,
        loserPersonId: loser.resource.id,
        reason: "A second merge must be fenced.",
      }),
    ).rejects.toMatchObject({ extensions: { code: "NOT_FOUND" } });

    const restored = await peopleService.unmerge({
      loserPersonId: loser.resource.id,
      expectedVersion: mergedRow!.version,
    });
    expect(restored.resource).toMatchObject({
      id: loser.resource.id,
      status: "active",
      mergedIntoPersonId: null,
      version: 3,
    });

    await expect(
      peopleService.unmerge({
        loserPersonId: loser.resource.id,
        expectedVersion: mergedRow!.version,
      }),
    ).resolves.toMatchObject({ resource: null, code: "CONFLICT" });
    const [finalLoser] = await fixture.database
      .select({
        status: people.status,
        mergedIntoPersonId: people.mergedIntoPersonId,
      })
      .from(people)
      .where(eq(people.id, loser.resource.id));
    expect(finalLoser).toMatchObject({
      status: "active",
      mergedIntoPersonId: null,
    });
  });
});
