// @vitest-environment node

import { and, count, eq } from "drizzle-orm";
import { createHash } from "node:crypto";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { newId } from "@/db/id";
import { sessions } from "@/db/schema/auth";
import { factDefinitions, facts } from "@/db/schema/facts";
import { files, importMappings, importRows, imports } from "@/db/schema/files";
import { auditEvents } from "@/db/schema/operations";
import { externalRecords, people, personNames } from "@/db/schema/people";
import { relationshipTypes, relationships } from "@/db/schema/relationships";
import { searchDocuments } from "@/db/schema/search";
import type { RedisStore } from "@/lib/redis";
import type { Database } from "@/modules/auth/bootstrap-admin";
import { rolePermissionKeys } from "@/modules/auth/permissions";
import type { ResearchServiceContext } from "@/modules/audit/service";
import { createEvidenceService } from "@/modules/evidence/service";
import { createFactsService } from "@/modules/facts/service";
import { createPeopleService } from "@/modules/people/service";
import { createRelationshipsService } from "@/modules/relationships/service";
import { createJobsService } from "@/modules/jobs/service";
import type {
  SearchIndexMaintenance,
  SearchIndexMutation,
} from "@/modules/search/index-maintenance";
import {
  createImportExecuteHandler,
  createImportExecuteService,
} from "@/worker/handlers/import";
import { createJobRegistry } from "@/worker/registry";
import { runJobsOnce } from "@/worker/run-once";

import type { SessionActor } from "../support/graphql";
import { ResearchFixture } from "../support/research-fixture";

const liveDescribe = process.env.TEST_DATABASE_URL ? describe : describe.skip;
const encryptionKey =
  "8e947ab119ee7657d188e7e0f4e2934fe665e3edcfbcb9d316d506910dbc8cba";

function canonicalJson(value: unknown): string {
  if (value === null || ["boolean", "string"].includes(typeof value)) {
    return JSON.stringify(value);
  }
  if (typeof value === "number") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (!value || typeof value !== "object") throw new TypeError("invalid");
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
    .join(",")}}`;
}

class MemoryRedis implements RedisStore {
  private readonly leases = new Map<string, string>();

  get(): Promise<string | null> {
    return Promise.resolve(null);
  }
  set(): Promise<void> {
    return Promise.resolve();
  }
  delete(): Promise<void> {
    return Promise.resolve();
  }
  increment(): Promise<number> {
    return Promise.resolve(1);
  }
  acquireLease(key: string, token: string): Promise<boolean> {
    if (this.leases.has(key)) return Promise.resolve(false);
    this.leases.set(key, token);
    return Promise.resolve(true);
  }
  extendLease(key: string, token: string): Promise<boolean> {
    return Promise.resolve(this.leases.get(key) === token);
  }
  releaseLease(key: string, token: string): Promise<boolean> {
    if (this.leases.get(key) !== token) return Promise.resolve(false);
    this.leases.delete(key);
    return Promise.resolve(true);
  }
  consumeTokenBucket(): Promise<{
    allowed: boolean;
    remainingMicrotokens: number;
    retryAfterMs: number;
  }> {
    return Promise.resolve({
      allowed: true,
      remainingMicrotokens: 0,
      retryAfterMs: 0,
    });
  }
}

async function stageWorkerImport(input: {
  actor: SessionActor;
  fixture: ResearchFixture;
  mode?: "COMMIT" | "DRY_RUN";
  operation: "PERSON" | "RELATIONSHIP";
  payload: Record<string, unknown>;
}) {
  const fileId = newId();
  const importId = newId();
  const mappingId = newId();
  const rowId = newId();
  const relationship = input.payload.relationship as
    Record<string, unknown> | undefined;
  const endpointMapping = (endpoint: unknown, source: string) => {
    const value = endpoint as Record<string, unknown> | undefined;
    return value?.kind === "EXTERNAL_KEY"
      ? {
          kind: "EXTERNAL_KEY" as const,
          personImportId: value.personImportId,
          source,
        }
      : { kind: "PERSON_ID" as const, source };
  };
  const definition =
    input.operation === "PERSON"
      ? {
          version: 1,
          recordKind: "PERSON" as const,
          rowKeySource: "external_id",
          person: {
            displayNameSource: "name",
            primaryNameKind:
              typeof input.payload.primaryNameKind === "string"
                ? input.payload.primaryNameKind
                : "legal",
            fields: [],
          },
          facts: [],
          defaults: {},
        }
      : {
          version: 1,
          recordKind: "RELATIONSHIP" as const,
          rowKeySource: "relationship_id",
          relationship: {
            typeId: relationship?.typeId,
            sourcePerson: endpointMapping(
              relationship?.sourcePerson,
              "source_person",
            ),
            targetPerson: endpointMapping(
              relationship?.targetPerson,
              "target_person",
            ),
            fields: [],
          },
          defaults: {},
        };
  const fileChecksum = `sha256:${"41".repeat(32)}`;
  const mappingHash = createHash("sha256")
    .update(canonicalJson(definition))
    .digest("hex");
  await input.fixture.database.insert(files).values({
    id: fileId,
    workspaceId: input.actor.workspaceId,
    storageProvider: "minio",
    storageBucket: "private",
    storageKey: `search-index-worker/${fileId}`,
    originalName: "worker.csv",
    mediaType: "text/csv",
    detectedType: "text/csv",
    byteSize: 10,
    checksum: fileChecksum,
    quarantineState: "available",
    scanState: "not_required",
    ocrState: "not_requested",
    extractionState: "not_requested",
    uploadedBy: input.actor.userId,
    createdBy: input.actor.principalId,
    updatedBy: input.actor.principalId,
  });
  await input.fixture.database.insert(importMappings).values({
    id: mappingId,
    workspaceId: input.actor.workspaceId,
    name: `search-index-${mappingId}`,
    format: "CSV",
    columnMapping: definition,
    validationConfig: {},
    createdBy: input.actor.userId,
    updatedBy: input.actor.userId,
  });
  await input.fixture.database.insert(imports).values({
    id: importId,
    workspaceId: input.actor.workspaceId,
    fileId,
    format: "CSV",
    state: "queued",
    mapping: {
      definition,
      fileChecksum,
      fileSize: 10,
      mappingHash,
      mappingId,
      mappingVersion: 1,
      mode: input.mode ?? "COMMIT",
      requestHash: "64".repeat(32),
    },
    idempotencyKey: `search-index-${importId}`,
    totalRows: 1,
    createdBy: input.actor.userId,
    updatedBy: input.actor.userId,
  });
  await input.fixture.database.insert(importRows).values({
    id: rowId,
    workspaceId: input.actor.workspaceId,
    importId,
    rowNumber: 1,
    sourceHash: `${"52".repeat(31)}01`,
    normalizedPayload: input.payload,
    state: "pending",
    createdBy: input.actor.userId,
    updatedBy: input.actor.userId,
  });
  const job = await createJobsService({
    database: input.fixture.database,
    encryptionKey,
  }).enqueue({
    workspaceId: input.actor.workspaceId,
    idempotencyKey: `search-index-job-${importId}`,
    payload: { kind: "import_execute", importId },
    createdBy: input.actor.userId,
  });
  await input.fixture.database
    .update(imports)
    .set({ executionJobId: job.id })
    .where(eq(imports.id, importId));
  return { importId, rowId };
}

async function runWorker(
  database: Database,
  searchIndexMaintenance: SearchIndexMaintenance,
) {
  return runJobsOnce({
    database,
    encryptionKey,
    redis: new MemoryRedis(),
    registry: createJobRegistry({
      aiExecute: async () => undefined,
      importExecute: createImportExecuteHandler(
        createImportExecuteService({
          database,
          encryptionKey,
          searchIndexMaintenance,
        }),
      ),
      fileCleanup: async () => undefined,
    }),
    workerId: newId(),
  });
}

async function serviceContext(
  fixture: ResearchFixture,
  actor: SessionActor,
  searchIndexMaintenance: SearchIndexMaintenance,
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
    permissions: rolePermissionKeys("owner"),
    requestId: newId(),
    searchIndexMaintenance,
    workspaceId: actor.workspaceId,
  };
}

function required<T>(value: T | null | undefined): T {
  if (value == null)
    throw new Error("Expected the mutation to return a resource.");
  return value;
}

liveDescribe("transactional search index maintenance", () => {
  const apply = vi.fn<SearchIndexMaintenance["apply"]>(async () => {});
  const searchIndexMaintenance: SearchIndexMaintenance = {
    mode: "transactional",
    apply,
  };
  let fixture: ResearchFixture;

  beforeAll(async () => {
    fixture = new ResearchFixture({ searchIndexMaintenance });
    await fixture.reset();
  });
  beforeEach(() => {
    apply.mockClear();
  });
  afterAll(async () => fixture.close());

  it("emits the accepted person create after its audit on the same transaction", async () => {
    const actor = await fixture.createActor();
    apply.mockImplementationOnce(async (database, [mutation]) => {
      expect(database).not.toBe(fixture.database);
      const [audit] = await database
        .select({ action: auditEvents.action })
        .from(auditEvents)
        .where(
          and(
            eq(auditEvents.workspaceId, actor.workspaceId),
            eq(auditEvents.resourceId, mutation!.sourceId),
          ),
        );
      expect(audit).toEqual({ action: "person.create" });
      await database.insert(searchDocuments).values({
        id: newId(),
        workspaceId: actor.workspaceId,
        resourceKind: "person",
        resourceId: mutation!.sourceId,
        redactedText: "transaction marker",
        resultKind: "PERSON",
        resultId: mutation!.sourceId,
        sensitivity: "internal",
        displayText: "transaction marker",
        sourceVersion: mutation!.sourceVersion,
      });
    });
    const result = await fixture.createPerson(actor, {
      displayName: "Task 12A Hook RED",
    });
    expect(
      result.body?.errors,
      JSON.stringify(fixture.capturedLogs),
    ).toBeUndefined();
    const person = result.body?.data?.createPerson?.person;
    expect(person).toBeTruthy();
    expect(apply).toHaveBeenCalledTimes(1);
    expect(apply.mock.calls[0]?.[1]).toEqual([
      {
        action: "upsert",
        sourceId: person!.id,
        sourceKind: "person",
        sourceVersion: person!.version,
        workspaceId: actor.workspaceId,
      },
    ]);
    const [marker] = await fixture.database
      .select({ resourceId: searchDocuments.resourceId })
      .from(searchDocuments)
      .where(eq(searchDocuments.resourceId, person!.id));
    expect(marker).toEqual({ resourceId: person!.id });
  });

  it("rolls the domain write and audit back when maintenance fails", async () => {
    const actor = await fixture.createActor();
    const before = await Promise.all([
      fixture.database
        .select({ value: count() })
        .from(people)
        .where(eq(people.workspaceId, actor.workspaceId)),
      fixture.database
        .select({ value: count() })
        .from(auditEvents)
        .where(eq(auditEvents.workspaceId, actor.workspaceId)),
    ]);
    apply.mockRejectedValueOnce(new Error("synthetic hook failure"));

    const result = await fixture.createPerson(actor, {
      displayName: "Must Roll Back",
    });

    expect(result.body?.data).toBeNull();
    expect(result.body?.errors).toHaveLength(1);
    expect(result.body?.errors?.[0]?.message).not.toContain(
      "synthetic hook failure",
    );
    const after = await Promise.all([
      fixture.database
        .select({ value: count() })
        .from(people)
        .where(eq(people.workspaceId, actor.workspaceId)),
      fixture.database
        .select({ value: count() })
        .from(auditEvents)
        .where(eq(auditEvents.workspaceId, actor.workspaceId)),
    ]);
    expect(after).toEqual(before);
  });

  it("maps every ordinary searchable mutation family without raw event fields", async () => {
    const actor = await fixture.createActor();
    const context = await serviceContext(
      fixture,
      actor,
      searchIndexMaintenance,
    );
    const emitted: SearchIndexMutation[] = [];
    apply.mockImplementation(async (...args) => {
      if (args.length !== 2) {
        throw new Error(`Unexpected hook arguments: ${args.length}`);
      }
      const [, mutations] = args;
      emitted.push(...mutations);
    });
    const peopleService = createPeopleService(context);
    const factsService = createFactsService(context);
    const relationshipsService = createRelationshipsService(context);
    const evidenceService = createEvidenceService(context);

    const firstPerson = required(
      (await peopleService.create({ displayName: "Mapping First" })).resource,
    );
    const secondPerson = required(
      (await peopleService.create({ displayName: "Mapping Second" })).resource,
    );
    const archivePerson = required(
      (await peopleService.create({ displayName: "Mapping Archive" })).resource,
    );
    const updatedPerson = required(
      (
        await peopleService.update({
          id: firstPerson.id,
          expectedVersion: firstPerson.version,
          displayName: "Mapping First Updated",
        })
      ).resource,
    );
    const archivedPerson = required(
      (
        await peopleService.archive({
          id: archivePerson.id,
          expectedVersion: archivePerson.version,
        })
      ).resource,
    );

    const definition = required(
      (
        await factsService.createDefinition({
          namespace: "task12",
          fieldKey: "mapping",
          label: "Mapping fact",
          allowedValueType: "text",
        })
      ).resource,
    );
    const updatedDefinition = required(
      (
        await factsService.updateDefinition({
          id: definition.id,
          expectedVersion: definition.version,
          label: "Mapping fact updated",
        })
      ).resource,
    );
    const fact = required(
      (
        await factsService.create({
          personId: firstPerson.id,
          definitionId: definition.id,
          value: { text: "private fact value" },
        })
      ).resource,
    );
    const revisedFact = required(
      (
        await factsService.revise({
          id: fact.id,
          expectedVersion: fact.version,
          value: { text: "private revised value" },
        })
      ).resource,
    );

    const relationshipType = required(
      (
        await relationshipsService.createType({
          key: "task12_mapping",
          forwardLabel: "maps to",
          inverseLabel: "mapped from",
        })
      ).resource,
    );
    const updatedRelationshipType = required(
      (
        await relationshipsService.updateType({
          id: relationshipType.id,
          expectedVersion: relationshipType.version,
          forwardLabel: "maps securely to",
        })
      ).resource,
    );
    const relationship = required(
      (
        await relationshipsService.create({
          sourcePersonId: firstPerson.id,
          targetPersonId: secondPerson.id,
          relationshipTypeId: relationshipType.id,
        })
      ).resource,
    );
    const updatedRelationship = required(
      (
        await relationshipsService.update({
          id: relationship.id,
          expectedVersion: relationship.version,
          labelOverride: "private relationship label",
        })
      ).resource,
    );
    const archivedRelationship = required(
      (
        await relationshipsService.archive({
          id: relationship.id,
          expectedVersion: updatedRelationship.version,
        })
      ).resource,
    );

    const source = required(
      (
        await evidenceService.createSource({
          kind: "document",
          title: "Private source title",
        })
      ).resource,
    );
    const updatedSource = required(
      (
        await evidenceService.updateSource({
          id: source.id,
          expectedVersion: source.version,
          title: "Private updated source title",
        })
      ).resource,
    );
    const evidence = required(
      (
        await evidenceService.createEvidence({
          sourceId: source.id,
          extractedText: "private evidence text",
          checksum: `sha256:${"1".repeat(64)}`,
        })
      ).resource,
    );
    const updatedEvidence = required(
      (
        await evidenceService.updateEvidence({
          id: evidence.id,
          expectedVersion: evidence.version,
          extractedText: "private updated evidence text",
        })
      ).resource,
    );
    const fileId = newId();
    await fixture.database.insert(files).values({
      id: fileId,
      workspaceId: actor.workspaceId,
      storageProvider: "minio",
      storageBucket: "private",
      storageKey: `task12/${fileId}`,
      originalName: "private-filename.txt",
      mediaType: "text/plain",
      detectedType: "text/plain",
      byteSize: 1,
      checksum: `sha256:${"2".repeat(64)}`,
      quarantineState: "available",
      scanState: "clean",
      ocrState: "not_requested",
      extractionState: "not_requested",
      uploadedBy: actor.userId,
      createdBy: actor.principalId,
      updatedBy: actor.principalId,
    });
    const attachedEvidence = required(
      (
        await evidenceService.attachFile({
          evidenceItemId: evidence.id,
          fileId,
          expectedVersion: updatedEvidence.version,
        })
      ).resource,
    );
    const excerpt = required(
      (
        await evidenceService.createExcerpt({
          evidenceItemId: evidence.id,
          excerpt: "private evidence excerpt",
          checksum: `sha256:${"3".repeat(64)}`,
        })
      ).resource,
    );
    const note = required(
      (
        await evidenceService.createNote({
          subject: { personId: firstPerson.id },
          content: { plainText: "private note" },
        })
      ).resource,
    );
    const updatedNote = required(
      (
        await evidenceService.updateNote({
          id: note.id,
          expectedVersion: note.version,
          content: { plainText: "private updated note" },
        })
      ).resource,
    );
    const archivedNote = required(
      (
        await evidenceService.archiveNote({
          id: note.id,
          expectedVersion: updatedNote.version,
        })
      ).resource,
    );

    expect(emitted).toEqual(
      [
        ["upsert", "person", firstPerson.id, firstPerson.version],
        ["upsert", "person", secondPerson.id, secondPerson.version],
        ["upsert", "person", archivePerson.id, archivePerson.version],
        ["upsert", "person", updatedPerson.id, updatedPerson.version],
        ["remove", "person", archivedPerson.id, archivedPerson.version],
        ["upsert", "fact_definition", definition.id, definition.version],
        [
          "upsert",
          "fact_definition",
          updatedDefinition.id,
          updatedDefinition.version,
        ],
        ["upsert", "fact", fact.id, fact.version],
        ["upsert", "fact", revisedFact.id, revisedFact.version],
        [
          "upsert",
          "relationship_type",
          relationshipType.id,
          relationshipType.version,
        ],
        [
          "upsert",
          "relationship_type",
          updatedRelationshipType.id,
          updatedRelationshipType.version,
        ],
        ["upsert", "relationship", relationship.id, relationship.version],
        [
          "upsert",
          "relationship",
          updatedRelationship.id,
          updatedRelationship.version,
        ],
        [
          "remove",
          "relationship",
          archivedRelationship.id,
          archivedRelationship.version,
        ],
        ["upsert", "source", source.id, source.version],
        ["upsert", "source", updatedSource.id, updatedSource.version],
        ["upsert", "evidence_item", evidence.id, evidence.version],
        [
          "upsert",
          "evidence_item",
          updatedEvidence.id,
          updatedEvidence.version,
        ],
        [
          "upsert",
          "evidence_item",
          attachedEvidence.id,
          attachedEvidence.version,
        ],
        ["upsert", "evidence_excerpt", excerpt.id, 1],
        ["upsert", "note", note.id, note.version],
        ["upsert", "note", updatedNote.id, updatedNote.version],
        ["remove", "note", archivedNote.id, archivedNote.version],
      ].map(([action, sourceKind, sourceId, sourceVersion]) => ({
        action,
        sourceId,
        sourceKind,
        sourceVersion,
        workspaceId: actor.workspaceId,
      })),
    );
    const serialized = JSON.stringify(emitted);
    for (const secret of [
      "private fact value",
      "private revised value",
      "private relationship label",
      "Private source title",
      "private evidence text",
      "private-filename.txt",
      "private evidence excerpt",
      "private note",
    ]) {
      expect(serialized).not.toContain(secret);
    }
  });

  it("does not invoke maintenance for rejected or foreign-workspace writes", async () => {
    const actor = await fixture.createActor();
    const foreignActor = await fixture.createActor();
    const foreignPerson = required(
      (
        await createPeopleService(
          await serviceContext(fixture, foreignActor, searchIndexMaintenance),
        ).create({ displayName: "Foreign Person" })
      ).resource,
    );
    apply.mockClear();
    const peopleService = createPeopleService(
      await serviceContext(fixture, actor, searchIndexMaintenance),
    );

    await expect(
      peopleService.create({ displayName: "" }),
    ).resolves.toMatchObject({ code: "VALIDATION_FAILED", resource: null });
    await expect(
      peopleService.update({
        id: foreignPerson.id,
        expectedVersion: foreignPerson.version,
        displayName: "Cross-workspace write",
      }),
    ).rejects.toMatchObject({ extensions: { code: "NOT_FOUND" } });
    expect(apply).not.toHaveBeenCalled();
  });

  it("maps committed worker PERSON identity and fact mutations without raw data", async () => {
    const actor = await fixture.createActor("owner");
    const definitionId = newId();
    await fixture.database.insert(factDefinitions).values({
      id: definitionId,
      workspaceId: actor.workspaceId,
      namespace: "person",
      fieldKey: "task12_worker_fact",
      label: "Worker fact",
      allowedValueType: "text",
      cardinality: "many",
      defaultSensitivity: "internal",
      state: "active",
      createdBy: actor.principalId,
      updatedBy: actor.principalId,
    });
    const staged = await stageWorkerImport({
      actor,
      fixture,
      operation: "PERSON",
      payload: {
        kind: "PERSON",
        rowKey: "task12-worker-person",
        person: { displayName: "Task 12 Worker Person" },
        primaryNameKind: "legal",
        facts: [{ definitionId, value: "private worker fact" }],
        defaults: { sensitivity: "internal", status: "active" },
      },
    });
    const emitted: SearchIndexMutation[] = [];
    apply.mockImplementation(async (_database, mutations) => {
      emitted.push(...mutations);
    });

    await expect(
      runWorker(fixture.database, searchIndexMaintenance),
    ).resolves.toMatchObject({ claimed: 1, completed: 1, deferred: 0 });
    const [person] = await fixture.database
      .select()
      .from(people)
      .where(eq(people.workspaceId, actor.workspaceId));
    const [name] = await fixture.database
      .select()
      .from(personNames)
      .where(eq(personNames.personId, person!.id));
    const [fact] = await fixture.database
      .select()
      .from(facts)
      .where(eq(facts.personId, person!.id));
    const [external] = await fixture.database
      .select()
      .from(externalRecords)
      .where(eq(externalRecords.personId, person!.id));
    expect(external?.importId).toBe(staged.importId);
    expect(
      emitted.map(({ action, sourceId, sourceKind, sourceVersion }) => ({
        action,
        sourceId,
        sourceKind,
        sourceVersion,
      })),
    ).toEqual([
      {
        action: "upsert",
        sourceId: person!.id,
        sourceKind: "person",
        sourceVersion: 1,
      },
      {
        action: "upsert",
        sourceId: name!.id,
        sourceKind: "person_name",
        sourceVersion: 1,
      },
      {
        action: "upsert",
        sourceId: person!.id,
        sourceKind: "person",
        sourceVersion: person!.version,
      },
      {
        action: "upsert",
        sourceId: fact!.id,
        sourceKind: "fact",
        sourceVersion: fact!.version,
      },
    ]);
    expect(JSON.stringify(emitted)).not.toContain("Task 12 Worker Person");
    expect(JSON.stringify(emitted)).not.toContain("private worker fact");
  });

  it("maps a committed worker RELATIONSHIP mutation", async () => {
    const actor = await fixture.createActor("owner");
    const sourcePersonId = required(
      (await fixture.createPerson(actor, { displayName: "Worker Source" })).body
        ?.data?.createPerson?.person?.id,
    );
    const targetPersonId = required(
      (await fixture.createPerson(actor, { displayName: "Worker Target" })).body
        ?.data?.createPerson?.person?.id,
    );
    const relationshipTypeId = newId();
    await fixture.database.insert(relationshipTypes).values({
      id: relationshipTypeId,
      workspaceId: actor.workspaceId,
      namespace: "workspace",
      key: `task12_worker_${relationshipTypeId.replaceAll("-", "")}`,
      forwardLabel: "worker link",
      inverseLabel: "worker linked from",
      directed: true,
      allowsSelf: false,
      allowedMultiplicity: "many_to_many",
      state: "active",
      createdBy: actor.principalId,
      updatedBy: actor.principalId,
    });
    await stageWorkerImport({
      actor,
      fixture,
      operation: "RELATIONSHIP",
      payload: {
        kind: "RELATIONSHIP",
        rowKey: "task12-worker-relationship",
        relationship: {
          typeId: relationshipTypeId,
          sourcePerson: { kind: "PERSON_ID", personId: sourcePersonId },
          targetPerson: { kind: "PERSON_ID", personId: targetPersonId },
        },
        defaults: { sensitivity: "internal", state: "asserted" },
      },
    });
    const emitted: SearchIndexMutation[] = [];
    apply.mockClear();
    apply.mockImplementation(async (_database, mutations) => {
      emitted.push(...mutations);
    });

    await expect(
      runWorker(fixture.database, searchIndexMaintenance),
    ).resolves.toMatchObject({ claimed: 1, completed: 1, deferred: 0 });
    const [relationship] = await fixture.database
      .select()
      .from(relationships)
      .where(eq(relationships.workspaceId, actor.workspaceId));
    expect(emitted).toEqual([
      {
        action: "upsert",
        sourceId: relationship!.id,
        sourceKind: "relationship",
        sourceVersion: relationship!.version,
        workspaceId: actor.workspaceId,
      },
    ]);
  });

  it("traverses worker DRY_RUN mappings and rolls their writes back", async () => {
    const actor = await fixture.createActor("owner");
    const staged = await stageWorkerImport({
      actor,
      fixture,
      mode: "DRY_RUN",
      operation: "PERSON",
      payload: {
        kind: "PERSON",
        rowKey: "task12-worker-dry-run",
        person: { displayName: "Private Dry Run Person" },
        primaryNameKind: "legal",
        facts: [],
        defaults: {},
      },
    });
    const emitted: SearchIndexMutation[] = [];
    apply.mockImplementation(async (_database, mutations) => {
      emitted.push(...mutations);
    });

    await expect(
      runWorker(fixture.database, searchIndexMaintenance),
    ).resolves.toMatchObject({ claimed: 1, completed: 1, deadLettered: 0 });
    const [personCount] = await fixture.database
      .select({ value: count() })
      .from(people)
      .where(eq(people.workspaceId, actor.workspaceId));
    const [nameCount] = await fixture.database
      .select({ value: count() })
      .from(personNames)
      .where(eq(personNames.workspaceId, actor.workspaceId));
    const [externalCount] = await fixture.database
      .select({ value: count() })
      .from(externalRecords)
      .where(eq(externalRecords.workspaceId, actor.workspaceId));
    const [row] = await fixture.database
      .select()
      .from(importRows)
      .where(eq(importRows.id, staged.rowId));
    expect([
      personCount?.value,
      nameCount?.value,
      externalCount?.value,
    ]).toEqual([0, 0, 0]);
    expect(row).toMatchObject({ state: "succeeded", resultReferences: [] });
    expect(emitted.map(({ sourceKind }) => sourceKind)).toEqual([
      "person",
      "person_name",
      "person",
    ]);
    expect(JSON.stringify(emitted)).not.toContain("Private Dry Run Person");
  });
});
