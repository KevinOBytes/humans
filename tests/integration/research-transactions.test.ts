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
import { count, eq } from "drizzle-orm";

import { members, sessions } from "@/db/schema/auth";
import { personTags, tags } from "@/db/schema/evidence";
import { factDefinitions, facts } from "@/db/schema/facts";
import { auditEvents, idempotencyKeys } from "@/db/schema/operations";
import { identityCandidates, people } from "@/db/schema/people";
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
});
