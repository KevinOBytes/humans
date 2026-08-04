// @vitest-environment node

import { count, eq, sql } from "drizzle-orm";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  expectTypeOf,
  it,
  vi,
} from "vitest";

import { newId } from "@/db/id";
import { members, sessions } from "@/db/schema/auth";
import { files, importRows, imports } from "@/db/schema/files";
import { auditEvents, jobs } from "@/db/schema/operations";
import { people } from "@/db/schema/people";
import type { GraphQLActor } from "@/graphql/context";
import type { Database } from "@/modules/auth/bootstrap-admin";
import * as auditModule from "@/modules/audit/service";
import type {
  ResearchActor,
  ResearchServiceContext,
} from "@/modules/audit/service";
import * as transactionModule from "@/modules/audit/transactions";
import { createJobsRepository } from "@/modules/jobs/repository";
import { encodeJobPayload } from "@/modules/jobs/service";
import { isPermanentJobError, jobFailureCode } from "@/modules/jobs/types";
import { createPeopleService } from "@/modules/people/service";
import {
  disabledSearchIndexMaintenance,
  type SearchIndexMaintenance,
} from "@/modules/search/index-maintenance";

import { createTestConnection, createTestDatabase } from "../support/auth";
import type { SessionActor } from "../support/graphql";
import { ResearchFixture } from "../support/research-fixture";

const liveDescribe = process.env.TEST_DATABASE_URL ? describe : describe.skip;

type RunWorker =
  typeof transactionModule.runDurableImportRowResearchTransaction;
type WorkerInput = Parameters<RunWorker>[1];
type Operation = "PERSON" | "RELATIONSHIP";
const TEST_ENCRYPTION_KEY =
  "8e947ab119ee7657d188e7e0f4e2934fe665e3edcfbcb9d316d506910dbc8cba";

describe("durable worker trust boundary", () => {
  it("exposes no worker trust mutator and keeps workers outside GraphQL actors", () => {
    type GraphQLWorker = Extract<GraphQLActor, { type: "worker" }>;
    type ResearchWorker = Extract<ResearchActor, { type: "worker" }>;
    expectTypeOf<GraphQLWorker>().toEqualTypeOf<never>();
    expectTypeOf<ResearchWorker>().not.toEqualTypeOf<never>();

    const exportedNames = [
      ...Object.keys(auditModule),
      ...Object.keys(transactionModule),
    ];
    expect(exportedNames).not.toContain("registerTrustedWorkerAuditContext");
    expect(exportedNames).not.toContain("retireTrustedWorkerAuditContext");
    expect(
      exportedNames.filter((name) =>
        /(register|retire|bless|set).*(worker|trust)|(worker|trust).*(register|retire|bless|set)/iu.test(
          name,
        ),
      ),
    ).toEqual([]);

    const forged = {
      actor: {
        type: "worker",
        id: "forged-user",
        principalId: newId(),
        memberId: "forged-member",
        role: "owner",
        importId: newId(),
        importRowId: newId(),
        jobId: newId(),
        leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
        leaseOwner: newId(),
        fencingToken: 1,
        operation: "PERSON",
      },
      database: {} as Database,
      permissions: new Set(["person:create"]),
      requestId: `worker:${newId()}`,
      searchIndexMaintenance: disabledSearchIndexMaintenance,
      workspaceId: newId(),
    } as ResearchServiceContext;
    expect(transactionModule.getTrustedWorkerAuditContext(forged)).toBeNull();
  });

  it("rejects inherited, unknown, accessor, and malformed rejection codes", () => {
    const inherited = Object.create({ code: "FACT_VALIDATION_FAILED" });
    const accessor = Object.defineProperty({}, "code", {
      enumerable: true,
      get: () => "FACT_VALIDATION_FAILED",
    });
    for (const input of [
      null,
      { code: "toString" },
      { code: "constructor" },
      { code: "UNKNOWN_REJECTION" },
      { code: "FACT_VALIDATION_FAILED", message: "row contents" },
      inherited,
      accessor,
    ]) {
      expect(() =>
        transactionModule.rejectDurableImportRow(input as never),
      ).toThrowError(
        expect.objectContaining({
          extensions: { code: "VALIDATION_FAILED" },
        }),
      );
    }
  });
});

async function seedBinding(
  fixture: ResearchFixture,
  actor: SessionActor,
  operation: Operation = "PERSON",
  leaseMs = 60_000,
  mode: "COMMIT" | "DRY_RUN" = "COMMIT",
): Promise<WorkerInput & { importId: string; rowId: string }> {
  const fileId = newId();
  const importId = newId();
  const rowId = newId();
  const jobId = newId();
  const leaseOwner = newId();
  const encoded = encodeJobPayload({
    key: TEST_ENCRYPTION_KEY,
    payload: { kind: "import_execute", importId },
  });
  await fixture.database.insert(files).values({
    id: fileId,
    workspaceId: actor.workspaceId,
    storageProvider: "minio",
    storageBucket: "private",
    storageKey: `worker-test/${fileId}`,
    originalName: "worker.csv",
    mediaType: "text/csv",
    detectedType: "text/csv",
    byteSize: 1,
    checksum: `sha256:${"11".repeat(32)}`,
    quarantineState: "available",
    scanState: "not_required",
    ocrState: "not_requested",
    extractionState: "not_requested",
    uploadedBy: actor.userId,
    createdBy: actor.principalId,
    updatedBy: actor.principalId,
  });
  await fixture.database.insert(imports).values({
    id: importId,
    workspaceId: actor.workspaceId,
    fileId,
    format: "CSV",
    state: "running",
    mapping: { definition: { recordKind: operation }, mode },
    idempotencyKey: `worker-test-${importId}`,
    totalRows: 1,
    createdBy: actor.userId,
    updatedBy: actor.userId,
  });
  await fixture.database.insert(importRows).values({
    id: rowId,
    workspaceId: actor.workspaceId,
    importId,
    rowNumber: 1,
    sourceHash: `sha256:${"33".repeat(32)}`,
    normalizedPayload:
      operation === "PERSON"
        ? { kind: operation, person: { displayName: "Worker Ada" } }
        : { kind: operation, relationship: {} },
    state: "processing",
    createdBy: actor.userId,
    updatedBy: actor.userId,
  });
  await fixture.database.insert(jobs).values({
    id: jobId,
    workspaceId: actor.workspaceId,
    kind: "import_execute",
    encryptedPayload: encoded.encryptedPayload,
    payloadHash: encoded.payloadHash,
    idempotencyKey: `worker-test-${jobId}`,
    state: "running",
    attemptCount: 1,
    claimGeneration: 1,
    leaseOwner,
    leaseExpiresAt: new Date(Date.now() + leaseMs),
    createdBy: actor.userId,
    updatedBy: actor.userId,
  });
  await fixture.database
    .update(imports)
    .set({ executionJobId: jobId })
    .where(eq(imports.id, importId));
  return {
    encryptionKey: TEST_ENCRYPTION_KEY,
    claimGeneration: 1,
    importId,
    importRowId: rowId,
    jobId,
    leaseOwner,
    searchIndexMaintenance: disabledSearchIndexMaintenance,
    rowId,
    workspaceId: actor.workspaceId,
  };
}

async function personCount(database: Database, workspaceId: string) {
  const [row] = await database
    .select({ value: count() })
    .from(people)
    .where(eq(people.workspaceId, workspaceId));
  return row?.value ?? 0;
}

async function executePerson(
  context: ResearchServiceContext,
  displayName: string,
) {
  const outcome = await createPeopleService(context).create({ displayName });
  if (!outcome.resource || outcome.code) {
    throw new Error("Import executor received an unsuccessful service outcome");
  }
  return {
    resultReferences: [outcome.resource.id],
    value: outcome.resource.id,
  };
}

async function expectForbidden(fixture: ResearchFixture, input: WorkerInput) {
  const execute = vi.fn(async () => ({ resultReferences: [], value: null }));
  await expect(
    transactionModule.runDurableImportRowResearchTransaction(
      fixture.database,
      input,
      execute,
    ),
  ).rejects.toMatchObject({ extensions: { code: "FORBIDDEN" } });
  expect(execute).not.toHaveBeenCalled();
}

liveDescribe("durable import row research transaction", () => {
  let fixture: ResearchFixture;

  beforeAll(() => {
    fixture = new ResearchFixture();
  });
  beforeEach(async () => fixture.reset());
  afterAll(async () => fixture.close());

  it("uses current authority without a session and atomically records row, domain, and system audit results", async () => {
    const actor = await fixture.createActor("owner");
    const binding = await seedBinding(fixture, actor);
    await fixture.database
      .delete(sessions)
      .where(eq(sessions.userId, actor.userId));
    let escaped: ResearchServiceContext | undefined;

    const result =
      await transactionModule.runDurableImportRowResearchTransaction(
        fixture.database,
        binding,
        async ({ context, row }) => {
          escaped = context;
          expect(row.id).toBe(binding.rowId);
          expect(Object.isFrozen(row)).toBe(true);
          expect(Object.isFrozen(context)).toBe(true);
          expect(Object.isFrozen(context.actor)).toBe(true);
          expect(Object.isFrozen(context.permissions)).toBe(true);
          expect([...context.permissions].sort()).toEqual([
            "fact:create",
            "person:create",
            "person:read",
          ]);
          expect(context.actor).toMatchObject({
            type: "worker",
            id: actor.userId,
            memberId: actor.memberId,
            principalId: actor.principalId,
            importId: binding.importId,
            importRowId: binding.rowId,
            jobId: binding.jobId,
            leaseOwner: binding.leaseOwner,
            fencingToken: binding.claimGeneration,
            operation: "PERSON",
          });
          const trusted =
            transactionModule.getTrustedWorkerAuditContext(context);
          expect(Object.isFrozen(trusted)).toBe(true);
          expect(trusted).toMatchObject({
            workspaceId: actor.workspaceId,
            userId: actor.userId,
            memberId: actor.memberId,
            principalId: actor.principalId,
            role: "owner",
            importId: binding.importId,
            importRowId: binding.rowId,
            jobId: binding.jobId,
            leaseOwner: binding.leaseOwner,
            fencingToken: binding.claimGeneration,
            operation: "PERSON",
          });
          expect(Reflect.set(context.actor, "jobId", newId())).toBe(false);
          const clone = { ...context } as ResearchServiceContext;
          await expect(
            createPeopleService(clone).create({ displayName: "Forged Clone" }),
          ).rejects.toMatchObject({ extensions: { code: "FORBIDDEN" } });
          return executePerson(context, "Worker Ada");
        },
      );

    expect(result).toMatchObject({
      status: "completed",
      value: result.resultReferences[0],
    });
    const [person] = await fixture.database
      .select()
      .from(people)
      .where(eq(people.workspaceId, actor.workspaceId));
    expect(person?.createdBy).toBe(actor.principalId);
    const [staged] = await fixture.database
      .select()
      .from(importRows)
      .where(eq(importRows.id, binding.rowId));
    expect(staged).toMatchObject({
      state: "succeeded",
      resultReferences: [person?.id],
      updatedBy: actor.userId,
    });
    const [audit] = await fixture.database
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.resourceId, person!.id));
    expect(audit).toMatchObject({
      action: "system.import.person.create",
      actorUserId: null,
      sessionId: null,
      apiKeyId: null,
      requestId: `worker:${binding.jobId}`,
      outcome: "success",
      redactedDiff: {
        worker: { importId: binding.importId, jobId: binding.jobId },
      },
    });

    if (!escaped) throw new Error("Expected a worker context");
    await expect(
      createPeopleService(escaped).create({ displayName: "Escaped Worker" }),
    ).rejects.toMatchObject({ extensions: { code: "PRECONDITION_FAILED" } });
  });

  it("rejects missing, expired, wrong, and replaced PostgreSQL leases", async () => {
    const missingActor = await fixture.createActor("owner");
    const missing = await seedBinding(fixture, missingActor);
    await fixture.database
      .update(jobs)
      .set({ leaseOwner: null, leaseExpiresAt: null })
      .where(eq(jobs.id, missing.jobId));
    await expectForbidden(fixture, missing);

    const expiredActor = await fixture.createActor("owner");
    const expired = await seedBinding(fixture, expiredActor);
    await fixture.database
      .update(jobs)
      .set({ leaseExpiresAt: new Date(Date.now() - 1_000) })
      .where(eq(jobs.id, expired.jobId));
    await expectForbidden(fixture, expired);

    const wrongActor = await fixture.createActor("owner");
    const wrong = await seedBinding(fixture, wrongActor);
    await expectForbidden(fixture, { ...wrong, leaseOwner: newId() });

    const replacedActor = await fixture.createActor("owner");
    const replaced = await seedBinding(fixture, replacedActor);
    await fixture.database
      .update(jobs)
      .set({
        attemptCount: 2,
        claimGeneration: 2,
        leaseOwner: newId(),
        leaseExpiresAt: new Date(Date.now() + 60_000),
      })
      .where(eq(jobs.id, replaced.jobId));
    await expectForbidden(fixture, replaced);
  });

  it("rejects revoked authority and accepts a rejoin through the historical durable principal", async () => {
    const revokedActor = await fixture.createActor("owner");
    const revoked = await seedBinding(fixture, revokedActor);
    await fixture.database
      .delete(members)
      .where(eq(members.id, revokedActor.memberId));
    await expectForbidden(fixture, revoked);

    const viewerActor = await fixture.createActor("owner");
    const viewer = await seedBinding(fixture, viewerActor);
    await fixture.database
      .update(members)
      .set({ role: "viewer" })
      .where(eq(members.id, viewerActor.memberId));
    await expectForbidden(fixture, viewer);

    const rejoinedActor = await fixture.createActor("owner");
    const rejoined = await seedBinding(fixture, rejoinedActor);
    await fixture.database
      .delete(members)
      .where(eq(members.id, rejoinedActor.memberId));
    const currentMemberId = newId();
    await fixture.database.insert(members).values({
      id: currentMemberId,
      organizationId: rejoinedActor.organizationId,
      userId: rejoinedActor.userId,
      role: "owner",
      workspaceId: rejoinedActor.workspaceId,
      createdAt: new Date(),
    });
    const result =
      await transactionModule.runDurableImportRowResearchTransaction(
        fixture.database,
        rejoined,
        async ({ context }) => {
          expect(context.actor).toMatchObject({
            memberId: currentMemberId,
            principalId: rejoinedActor.principalId,
          });
          return executePerson(context, "Rejoined Worker");
        },
      );
    expect(result.status).toBe("completed");
    const [person] = await fixture.database
      .select()
      .from(people)
      .where(eq(people.workspaceId, rejoinedActor.workspaceId));
    expect(person?.createdBy).toBe(rejoinedActor.principalId);
  });

  it("accepts an authorized peer initiator but rejects kind, import state, sealed payload, row state, and row operation", async () => {
    const creatorActor = await fixture.createActor("owner");
    const wrongCreator = await seedBinding(fixture, creatorActor);
    const otherMember = await fixture.createWorkspaceMember(
      creatorActor,
      "contributor",
    );
    await fixture.database
      .update(jobs)
      .set({ createdBy: otherMember.userId, updatedBy: otherMember.userId })
      .where(eq(jobs.id, wrongCreator.jobId));
    const peerResult =
      await transactionModule.runDurableImportRowResearchTransaction(
        fixture.database,
        wrongCreator,
        async ({ context }) => {
          expect(context.actor).toMatchObject({
            id: otherMember.userId,
            memberId: otherMember.memberId,
            principalId: otherMember.principalId,
          });
          return { resultReferences: [], value: null };
        },
      );
    expect(peerResult).toMatchObject({ status: "completed" });

    const kindActor = await fixture.createActor("owner");
    const wrongKind = await seedBinding(fixture, kindActor);
    await fixture.database
      .update(jobs)
      .set({ kind: "file_cleanup" })
      .where(eq(jobs.id, wrongKind.jobId));
    await expectForbidden(fixture, wrongKind);

    const stateActor = await fixture.createActor("owner");
    const wrongImportState = await seedBinding(fixture, stateActor);
    await fixture.database
      .update(imports)
      .set({ state: "queued" })
      .where(eq(imports.id, wrongImportState.importId));
    await expectForbidden(fixture, wrongImportState);

    const keyActor = await fixture.createActor("owner");
    const wrongKey = await seedBinding(fixture, keyActor);
    await expectForbidden(fixture, {
      ...wrongKey,
      encryptionKey:
        "7165f770dd3fedb0ab5f9538291964da331731cfe32df0c770125b6286ad5621",
    });

    const tamperedActor = await fixture.createActor("owner");
    const tamperedPayload = await seedBinding(fixture, tamperedActor);
    await fixture.database
      .update(jobs)
      .set({ encryptedPayload: "tampered-sealed-payload" })
      .where(eq(jobs.id, tamperedPayload.jobId));
    await expectForbidden(fixture, tamperedPayload);

    const crossImportActor = await fixture.createActor("owner");
    const firstImport = await seedBinding(fixture, crossImportActor);
    const secondImport = await seedBinding(fixture, crossImportActor);
    await expectForbidden(fixture, {
      ...firstImport,
      importRowId: secondImport.rowId,
    });
    const sealedForSecond = encodeJobPayload({
      key: TEST_ENCRYPTION_KEY,
      payload: { kind: "import_execute", importId: secondImport.importId },
    });
    await fixture.database
      .update(jobs)
      .set({
        encryptedPayload: sealedForSecond.encryptedPayload,
        payloadHash: sealedForSecond.payloadHash,
      })
      .where(eq(jobs.id, firstImport.jobId));
    await expectForbidden(fixture, firstImport);

    const rowActor = await fixture.createActor("owner");
    const wrongRow = await seedBinding(fixture, rowActor);
    await expectForbidden(fixture, { ...wrongRow, importRowId: newId() });

    const rowStateActor = await fixture.createActor("owner");
    const wrongRowState = await seedBinding(fixture, rowStateActor);
    await fixture.database
      .update(importRows)
      .set({ state: "pending" })
      .where(eq(importRows.id, wrongRowState.rowId));
    await expectForbidden(fixture, wrongRowState);

    const operationActor = await fixture.createActor("owner");
    const wrongOperation = await seedBinding(fixture, operationActor);
    await fixture.database
      .update(imports)
      .set({ mapping: { definition: { recordKind: "RELATIONSHIP" } } })
      .where(eq(imports.id, wrongOperation.importId));
    await expectForbidden(fixture, wrongOperation);
  });

  it("rolls back domain, audit, and row completion when the executor throws on an unsuccessful outcome", async () => {
    const actor = await fixture.createActor("owner");
    const binding = await seedBinding(fixture, actor);
    await expect(
      transactionModule.runDurableImportRowResearchTransaction(
        fixture.database,
        binding,
        async ({ context }) => {
          const invalid = await createPeopleService(context).create({
            displayName: "",
          });
          expect(invalid).toMatchObject({
            code: "VALIDATION_FAILED",
            resource: null,
          });
          throw new Error("executor rejected unsuccessful service outcome");
        },
      ),
    ).rejects.toThrow("executor rejected unsuccessful service outcome");
    expect(await personCount(fixture.database, actor.workspaceId)).toBe(0);
    const [staged] = await fixture.database
      .select()
      .from(importRows)
      .where(eq(importRows.id, binding.rowId));
    expect(staged).toMatchObject({ state: "processing", resultReferences: [] });
    const [auditCount] = await fixture.database
      .select({ value: count() })
      .from(auditEvents)
      .where(eq(auditEvents.workspaceId, actor.workspaceId));
    expect(auditCount?.value).toBe(0);
  });

  it("rolls back successful domain and audit writes when row execution later fails", async () => {
    const actor = await fixture.createActor("owner");
    const binding = await seedBinding(fixture, actor);
    await expect(
      transactionModule.runDurableImportRowResearchTransaction(
        fixture.database,
        binding,
        async ({ context }) => {
          await executePerson(context, "Rollback Worker");
          throw new Error("expected worker rollback");
        },
      ),
    ).rejects.toThrow("expected worker rollback");
    expect(await personCount(fixture.database, actor.workspaceId)).toBe(0);
    const [staged] = await fixture.database
      .select()
      .from(importRows)
      .where(eq(importRows.id, binding.rowId));
    expect(staged?.state).toBe("processing");
    const [auditCount] = await fixture.database
      .select({ value: count() })
      .from(auditEvents)
      .where(eq(auditEvents.workspaceId, actor.workspaceId));
    expect(auditCount?.value).toBe(0);
  });

  it("rolls back an off-operation service action before row completion", async () => {
    const actor = await fixture.createActor("owner");
    const binding = await seedBinding(fixture, actor, "RELATIONSHIP");
    await expect(
      transactionModule.runDurableImportRowResearchTransaction(
        fixture.database,
        binding,
        ({ context }) => executePerson(context, "Wrong Operation"),
      ),
    ).rejects.toMatchObject({ extensions: { code: "FORBIDDEN" } });
    expect(await personCount(fixture.database, actor.workspaceId)).toBe(0);
    const [staged] = await fixture.database
      .select()
      .from(importRows)
      .where(eq(importRows.id, binding.rowId));
    expect(staged).toMatchObject({ state: "processing", resultReferences: [] });
    const [auditCount] = await fixture.database
      .select({ value: count() })
      .from(auditEvents)
      .where(eq(auditEvents.workspaceId, actor.workspaceId));
    expect(auditCount?.value).toBe(0);
  });

  it("rolls back when the PostgreSQL lease expires during the callback", async () => {
    const actor = await fixture.createActor("owner");
    const binding = await seedBinding(fixture, actor, "PERSON", 1_000);
    const apply = vi.fn<SearchIndexMaintenance["apply"]>(async () => {});
    await expect(
      transactionModule.runDurableImportRowResearchTransaction(
        fixture.database,
        {
          ...binding,
          searchIndexMaintenance: { mode: "transactional", apply },
        },
        async ({ context }) => {
          const success = await executePerson(context, "Expired Mid Row");
          await context.database.execute(sql`select pg_sleep(1.2)`);
          return success;
        },
      ),
    ).rejects.toMatchObject({ extensions: { code: "FORBIDDEN" } });
    expect(await personCount(fixture.database, actor.workspaceId)).toBe(0);
    const [staged] = await fixture.database
      .select()
      .from(importRows)
      .where(eq(importRows.id, binding.rowId));
    expect(staged).toMatchObject({ state: "processing", resultReferences: [] });
    const [auditCount] = await fixture.database
      .select({ value: count() })
      .from(auditEvents)
      .where(eq(auditEvents.workspaceId, actor.workspaceId));
    expect(auditCount?.value).toBe(0);
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it("serializes a role race and permits exactly the transaction authorized before the downgrade", async () => {
    const actor = await fixture.createActor("owner");
    const binding = await seedBinding(fixture, actor);
    const firstConnection = createTestConnection(2);
    const secondConnection = createTestConnection(2);
    const firstDatabase = createTestDatabase(firstConnection);
    const secondDatabase = createTestDatabase(secondConnection);
    let entered!: () => void;
    let release!: () => void;
    const enteredPromise = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const releasePromise = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      const execution =
        transactionModule.runDurableImportRowResearchTransaction(
          firstDatabase,
          binding,
          async ({ context }) => {
            entered();
            await releasePromise;
            return executePerson(context, "Role Race Winner");
          },
        );
      await enteredPromise;
      let downgradeSettled = false;
      const downgrade = secondDatabase
        .update(members)
        .set({ role: "viewer" })
        .where(eq(members.id, actor.memberId))
        .then(() => {
          downgradeSettled = true;
        });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(downgradeSettled).toBe(false);
      release();
      const completed = await execution;
      expect(completed.status).toBe("completed");
      await downgrade;

      const afterDowngrade = await seedBinding(fixture, actor);
      await expectForbidden(fixture, afterDowngrade);
    } finally {
      release();
      await Promise.all([firstConnection.end(), secondConnection.end()]);
    }
  });

  it("allows only the current fencing token to commit during a stale/current race", async () => {
    const actor = await fixture.createActor("owner");
    const stale = await seedBinding(fixture, actor);
    const currentOwner = newId();
    await fixture.database
      .update(jobs)
      .set({
        attemptCount: 2,
        claimGeneration: 2,
        leaseOwner: currentOwner,
        leaseExpiresAt: new Date(Date.now() + 60_000),
      })
      .where(eq(jobs.id, stale.jobId));
    const current = {
      ...stale,
      claimGeneration: 2,
      leaseOwner: currentOwner,
    };
    const staleExecute = vi.fn(async ({ context }) =>
      executePerson(context, "Stale Worker"),
    );
    const currentExecute = vi.fn(async ({ context }) =>
      executePerson(context, "Current Worker"),
    );
    const firstConnection = createTestConnection(2);
    const secondConnection = createTestConnection(2);
    try {
      const results = await Promise.allSettled([
        transactionModule.runDurableImportRowResearchTransaction(
          createTestDatabase(firstConnection),
          stale,
          staleExecute,
        ),
        transactionModule.runDurableImportRowResearchTransaction(
          createTestDatabase(secondConnection),
          current,
          currentExecute,
        ),
      ]);
      expect(
        results.filter((result) => result.status === "fulfilled"),
      ).toHaveLength(1);
      expect(
        results.filter((result) => result.status === "rejected"),
      ).toHaveLength(1);
      expect(staleExecute).not.toHaveBeenCalled();
      expect(currentExecute).toHaveBeenCalledOnce();
      expect(await personCount(fixture.database, actor.workspaceId)).toBe(1);
    } finally {
      await Promise.all([firstConnection.end(), secondConnection.end()]);
    }
  });

  it("replays a finished row as a no-op before the job completes separately", async () => {
    const actor = await fixture.createActor("owner");
    const binding = await seedBinding(fixture, actor);
    const first =
      await transactionModule.runDurableImportRowResearchTransaction(
        fixture.database,
        binding,
        ({ context }) => executePerson(context, "Retry Once"),
      );
    expect(first.status).toBe("completed");
    const duplicate = vi.fn(async () => {
      throw new Error("completed row must not execute twice");
    });
    const reclaimedLeaseOwner = newId();
    await fixture.database
      .update(jobs)
      .set({
        attemptCount: 2,
        claimGeneration: 2,
        leaseOwner: reclaimedLeaseOwner,
        leaseExpiresAt: new Date(Date.now() + 60_000),
      })
      .where(eq(jobs.id, binding.jobId));
    const reclaimed = {
      ...binding,
      claimGeneration: 2,
      leaseOwner: reclaimedLeaseOwner,
    };
    const replay =
      await transactionModule.runDurableImportRowResearchTransaction(
        fixture.database,
        reclaimed,
        duplicate,
      );
    expect(replay).toEqual({
      status: "already_finished",
      value: null,
      resultReferences: first.resultReferences,
    });
    expect(duplicate).not.toHaveBeenCalled();
    expect(await personCount(fixture.database, actor.workspaceId)).toBe(1);

    const completed = await createJobsRepository(
      fixture.database,
    ).completeClaim({
      claimGeneration: 2,
      id: binding.jobId,
      workspaceId: binding.workspaceId,
      leaseOwner: reclaimedLeaseOwner,
      now: new Date(),
      resultReferences: replay.resultReferences,
    });
    expect(completed).toBe(true);
    const [job] = await fixture.database
      .select()
      .from(jobs)
      .where(eq(jobs.id, binding.jobId));
    expect(job).toMatchObject({ state: "completed", leaseOwner: null });
  });

  it("uses one caller-owned transaction without a savepoint", async () => {
    const actor = await fixture.createActor("owner");
    const binding = await seedBinding(fixture, actor);
    const apply = vi.fn<SearchIndexMaintenance["apply"]>(async () => {});
    const statements: string[] = [];
    const connection = createTestConnection(4, (_connection, query) =>
      statements.push(query),
    );
    let callerOwnedDatabase: Database | null = null;
    try {
      await transactionModule.runDurableImportRowResearchTransaction(
        createTestDatabase(connection),
        {
          ...binding,
          searchIndexMaintenance: { mode: "transactional", apply },
        },
        ({ context }) => {
          callerOwnedDatabase = context.database;
          return executePerson(context, "One Transaction");
        },
      );
    } finally {
      await connection.end();
    }
    expect(statements.some((statement) => /savepoint/iu.test(statement))).toBe(
      false,
    );
    expect(
      statements.filter((statement) => /^begin\b/iu.test(statement.trim())),
    ).toHaveLength(1);
    expect(apply).toHaveBeenCalledTimes(1);
    expect(apply.mock.calls[0]?.[0]).toBe(callerOwnedDatabase);
  });

  it("fails closed on a missing locked execution mode before invoking the callback", async () => {
    const actor = await fixture.createActor("owner");
    const binding = await seedBinding(fixture, actor);
    await fixture.database
      .update(imports)
      .set({ mapping: { definition: { recordKind: "PERSON" } } })
      .where(eq(imports.id, binding.importId));
    await expectForbidden(fixture, binding);
    const [row] = await fixture.database
      .select()
      .from(importRows)
      .where(eq(importRows.id, binding.rowId));
    expect(row?.state).toBe("processing");
  });

  it("rolls back forged diagnostics without persisting them", async () => {
    const actor = await fixture.createActor("owner");
    const binding = await seedBinding(fixture, actor);
    await expect(
      transactionModule.runDurableImportRowResearchTransaction(
        fixture.database,
        binding,
        async ({ context }) => {
          await executePerson(context, "Forged Diagnostic Person");
          return transactionModule.rejectDurableImportRow({
            code: "toString",
          } as never);
        },
      ),
    ).rejects.toMatchObject({ extensions: { code: "VALIDATION_FAILED" } });
    expect(await personCount(fixture.database, actor.workspaceId)).toBe(0);
    const [row] = await fixture.database
      .select()
      .from(importRows)
      .where(eq(importRows.id, binding.rowId));
    expect(row).toMatchObject({
      state: "processing",
      resultReferences: [],
      validationErrors: [],
    });
  });

  it("rolls back partial domain writes before atomically rejecting a row with bounded diagnostics", async () => {
    const actor = await fixture.createActor("owner");
    const binding = await seedBinding(fixture, actor);
    const statements: string[] = [];
    const connection = createTestConnection(4, (_connection, query) =>
      statements.push(query),
    );
    try {
      const result =
        await transactionModule.runDurableImportRowResearchTransaction(
          createTestDatabase(connection),
          binding,
          async ({ context, mode }) => {
            expect(mode).toBe("COMMIT");
            await executePerson(context, "Rejected Partial Person");
            return transactionModule.rejectDurableImportRow({
              code: "FACT_VALIDATION_FAILED",
            });
          },
        );
      expect(result).toEqual({
        resultReferences: [],
        status: "rejected",
        value: null,
      });
    } finally {
      await connection.end();
    }
    expect(await personCount(fixture.database, actor.workspaceId)).toBe(0);
    const [auditCount] = await fixture.database
      .select({ value: count() })
      .from(auditEvents)
      .where(eq(auditEvents.workspaceId, actor.workspaceId));
    expect(auditCount?.value).toBe(0);
    const [row] = await fixture.database
      .select()
      .from(importRows)
      .where(eq(importRows.id, binding.rowId));
    expect(row).toMatchObject({
      state: "rejected",
      resultReferences: [],
      validationErrors: [
        {
          code: "FACT_VALIDATION_FAILED",
          message: "The imported fact is invalid.",
        },
      ],
      updatedBy: actor.userId,
    });
    expect(statements.some((statement) => /savepoint/iu.test(statement))).toBe(
      false,
    );
    expect(
      statements.filter((statement) => /^begin\b/iu.test(statement.trim())),
    ).toHaveLength(2);

    const replay = vi.fn(async () => {
      throw new Error("rejected row must not execute twice");
    });
    const reclaimedLeaseOwner = newId();
    await fixture.database
      .update(jobs)
      .set({
        attemptCount: 2,
        claimGeneration: 2,
        leaseOwner: reclaimedLeaseOwner,
        leaseExpiresAt: new Date(Date.now() + 60_000),
      })
      .where(eq(jobs.id, binding.jobId));
    await expect(
      transactionModule.runDurableImportRowResearchTransaction(
        fixture.database,
        {
          ...binding,
          claimGeneration: 2,
          leaseOwner: reclaimedLeaseOwner,
        },
        replay,
      ),
    ).resolves.toEqual({
      resultReferences: [],
      status: "already_finished",
      value: null,
    });
    expect(replay).not.toHaveBeenCalled();
  });

  it("traverses dry-run domain services then rolls them back before persisting success", async () => {
    const actor = await fixture.createActor("owner");
    const binding = await seedBinding(
      fixture,
      actor,
      "PERSON",
      60_000,
      "DRY_RUN",
    );
    const apply = vi.fn<SearchIndexMaintenance["apply"]>(async () => {});
    const result =
      await transactionModule.runDurableImportRowResearchTransaction(
        fixture.database,
        {
          ...binding,
          searchIndexMaintenance: { mode: "transactional", apply },
        },
        async ({ context, mode }) => {
          expect(mode).toBe("DRY_RUN");
          await executePerson(context, "Dry Run Person");
          return transactionModule.completeDurableImportRowDryRun();
        },
      );
    expect(result).toEqual({
      resultReferences: [],
      status: "dry_run_completed",
      value: null,
    });
    expect(await personCount(fixture.database, actor.workspaceId)).toBe(0);
    const [auditCount] = await fixture.database
      .select({ value: count() })
      .from(auditEvents)
      .where(eq(auditEvents.workspaceId, actor.workspaceId));
    expect(auditCount?.value).toBe(0);
    const [row] = await fixture.database
      .select()
      .from(importRows)
      .where(eq(importRows.id, binding.rowId));
    expect(row).toMatchObject({
      state: "succeeded",
      resultReferences: [],
      validationErrors: [],
    });
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it("never commits a normally returned dry-run callback", async () => {
    const actor = await fixture.createActor("owner");
    const binding = await seedBinding(
      fixture,
      actor,
      "PERSON",
      60_000,
      "DRY_RUN",
    );
    await expect(
      transactionModule.runDurableImportRowResearchTransaction(
        fixture.database,
        binding,
        ({ context }) => executePerson(context, "Leaking Dry Run"),
      ),
    ).rejects.toMatchObject({
      extensions: { code: "PRECONDITION_FAILED" },
    });
    expect(await personCount(fixture.database, actor.workspaceId)).toBe(0);
    const [row] = await fixture.database
      .select()
      .from(importRows)
      .where(eq(importRows.id, binding.rowId));
    expect(row).toMatchObject({ state: "processing", resultReferences: [] });
  });

  it("does not persist a row outcome when the lease expires before rollback finalization", async () => {
    const actor = await fixture.createActor("owner");
    const binding = await seedBinding(fixture, actor, "PERSON", 1_000);
    let traversed = false;
    const failure = await transactionModule
      .runDurableImportRowResearchTransaction(
        fixture.database,
        binding,
        async ({ context }) => {
          traversed = true;
          await executePerson(context, "Expired Finalization Person");
          await context.database.execute(sql`select pg_sleep(1.2)`);
          return transactionModule.rejectDurableImportRow({
            code: "FACT_VALIDATION_FAILED",
          });
        },
      )
      .then(
        () => null,
        (error: unknown) => error,
      );
    expect(traversed).toBe(true);
    expect(failure).toMatchObject({
      code: "lease_lost",
      failureKind: "retryable",
    });
    expect(isPermanentJobError(failure)).toBe(false);
    expect(jobFailureCode(failure)).toBe("lease_lost");
    expect(await personCount(fixture.database, actor.workspaceId)).toBe(0);
    const [auditCount] = await fixture.database
      .select({ value: count() })
      .from(auditEvents)
      .where(eq(auditEvents.workspaceId, actor.workspaceId));
    expect(auditCount?.value).toBe(0);
    const [row] = await fixture.database
      .select()
      .from(importRows)
      .where(eq(importRows.id, binding.rowId));
    expect(row).toMatchObject({ state: "processing", resultReferences: [] });
  });
});
