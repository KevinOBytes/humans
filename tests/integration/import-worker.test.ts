// @vitest-environment node

import { and, eq, inArray } from "drizzle-orm";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { newId } from "@/db/id";
import { sessions } from "@/db/schema/auth";
import { factDefinitions, facts } from "@/db/schema/facts";
import {
  files,
  importMappings,
  importRows,
  imports,
  uploadSessions,
} from "@/db/schema/files";
import { auditEvents, jobs } from "@/db/schema/operations";
import { externalRecords, people, personNames } from "@/db/schema/people";
import { places } from "@/db/schema/locations";
import { relationshipTypes, relationships } from "@/db/schema/relationships";
import type { RedisStore } from "@/lib/redis";
import type { ObjectStore } from "@/lib/storage/types";
import type { Database } from "@/modules/auth/bootstrap-admin";
import { createImportsService } from "@/modules/imports/service";
import {
  disabledSearchIndexMaintenance,
  type SearchIndexMaintenance,
} from "@/modules/search/index-maintenance";
import { createJobsService, encodeJobPayload } from "@/modules/jobs/service";
import * as importHandlerModule from "@/worker/handlers/import";
import { createImportExecuteHandler } from "@/worker/handlers/import";
import { createJobRegistry } from "@/worker/registry";
import { runJobsOnce } from "@/worker/run-once";

import { ResearchFixture } from "../support/research-fixture";
import type { SessionActor } from "../support/graphql";

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

class ImportObjectStore implements ObjectStore {
  constructor(
    private readonly workspaceId: string,
    private readonly key: string,
    private readonly body: Uint8Array,
  ) {}

  createUpload(): Promise<never> {
    return Promise.reject(new Error("not used"));
  }
  createDownload(): Promise<never> {
    return Promise.reject(new Error("not used"));
  }
  async checkReachability() {}
  async getMetadata(input: { workspaceId: string; key: string }) {
    return input.workspaceId === this.workspaceId && input.key === this.key
      ? { bytes: this.body.byteLength, custom: {} }
      : null;
  }
  async openRead(input: { workspaceId: string; key: string }) {
    return input.workspaceId === this.workspaceId && input.key === this.key
      ? { bytes: this.body.byteLength, body: Readable.from([this.body]) }
      : null;
  }
  async exists(input: { workspaceId: string; key: string }) {
    return input.workspaceId === this.workspaceId && input.key === this.key;
  }
  async delete() {}
}

type CreateImportExecuteService = (input: {
  database: Database;
  encryptionKey: string;
  searchIndexMaintenance: SearchIndexMaintenance;
  now?: () => Date;
}) => importHandlerModule.ImportExecuteJobService;

function createExecutor(database: Database) {
  const value = (
    importHandlerModule as typeof importHandlerModule & {
      createImportExecuteService?: CreateImportExecuteService;
    }
  ).createImportExecuteService;
  expect(value).toBeTypeOf("function");
  return value!({
    database,
    encryptionKey,
    searchIndexMaintenance: disabledSearchIndexMaintenance,
  });
}

async function seedImport(input: {
  actor: SessionActor;
  fixture: ResearchFixture;
  importState?: "queued" | "running";
  mode?: "COMMIT" | "DRY_RUN";
  operation: "PERSON" | "RELATIONSHIP";
  payload: unknown;
  payloads?: readonly unknown[];
  rowState?: "pending" | "processing";
  updatedAt?: Date;
}) {
  const fileId = newId();
  const importId = newId();
  const mappingId = newId();
  const payloads = input.payloads ?? [input.payload];
  const rowIds = payloads.map(() => newId());
  const firstPayload = input.payload as Record<string, unknown>;
  const relationship = firstPayload.relationship as
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
          recordKind: "PERSON",
          rowKeySource: "external_id",
          person: {
            displayNameSource: "name",
            primaryNameKind:
              typeof firstPayload.primaryNameKind === "string"
                ? firstPayload.primaryNameKind
                : "legal",
            fields: [],
          },
          facts: [],
          defaults: {},
        }
      : {
          version: 1,
          recordKind: "RELATIONSHIP",
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
    storageKey: `import-worker/${fileId}`,
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
    name: `worker-${mappingId}`,
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
    state: input.importState ?? "queued",
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
    idempotencyKey: `worker-${importId}`,
    totalRows: payloads.length,
    startedAt: input.importState === "running" ? new Date() : null,
    createdBy: input.actor.userId,
    updatedBy: input.actor.userId,
  });
  await input.fixture.database.insert(importRows).values(
    payloads.map((payload, index) => ({
      id: rowIds[index]!,
      workspaceId: input.actor.workspaceId,
      importId,
      rowNumber: index + 1,
      sourceHash: `${"52".repeat(31)}${(index + 1).toString(16).padStart(2, "0")}`,
      normalizedPayload: payload,
      state: input.rowState ?? "pending",
      createdBy: input.actor.userId,
      updatedAt: input.updatedAt,
      updatedBy: input.actor.userId,
    })),
  );
  const job = await createJobsService({
    database: input.fixture.database,
    encryptionKey,
  }).enqueue({
    workspaceId: input.actor.workspaceId,
    idempotencyKey: `worker-job-${importId}`,
    payload: { kind: "import_execute", importId },
    createdBy: input.actor.userId,
  });
  await input.fixture.database
    .update(imports)
    .set({ executionJobId: job.id })
    .where(eq(imports.id, importId));
  return { importId, jobId: job.id, rowId: rowIds[0]!, rowIds };
}

async function seedFutureImport(input: {
  actor: SessionActor;
  fixture: ResearchFixture;
  suffix: string;
}) {
  const staged = await seedImport({
    actor: input.actor,
    fixture: input.fixture,
    operation: "PERSON",
    payload: {
      kind: "PERSON",
      rowKey: `future-${input.suffix}`,
      person: { displayName: `Future ${input.suffix}` },
      primaryNameKind: "legal",
      facts: [],
      defaults: {},
    },
  });
  await input.fixture.database
    .update(jobs)
    .set({ scheduledAt: new Date(Date.now() + 86_400_000) })
    .where(eq(jobs.id, staged.jobId));
  return staged;
}

async function runWorker(fixture: ResearchFixture, workerId: string) {
  return runJobsOnce({
    database: fixture.database,
    encryptionKey,
    redis: new MemoryRedis(),
    registry: createJobRegistry({
      aiExecute: async () => undefined,
      importExecute: createImportExecuteHandler(
        createExecutor(fixture.database),
      ),
      fileCleanup: async () => undefined,
    }),
    workerId,
  });
}

function required<T>(value: T | null | undefined): T {
  if (value == null) throw new Error("Missing required fixture value");
  return value;
}

async function importsServiceFor(
  fixture: ResearchFixture,
  actor: SessionActor,
  objectStore?: ObjectStore,
) {
  const [session] = await fixture.database
    .select({ id: sessions.id })
    .from(sessions)
    .where(eq(sessions.userId, actor.userId));
  if (!session) throw new Error("fixture session is missing");
  return createImportsService(
    {
      actor: {
        type: "user" as const,
        id: actor.userId,
        memberId: actor.memberId,
        principalId: actor.principalId,
        role: "owner",
        sessionId: session.id,
      },
      database: fixture.database,
      operationLimiter: {
        consume: async () => ({
          allowed: true,
          remainingMicrotokens: 1,
          retryAfterMs: 0,
        }),
      },
      permissions: new Set([
        "import:create",
        "import:update",
        "import:read",
        "import:run",
        "fact:create",
        "person:create",
        "person:read",
      ]),
      requestId: newId(),
      searchIndexMaintenance: disabledSearchIndexMaintenance,
      workspaceId: actor.workspaceId,
    },
    { encryptionKey, objectStore },
  );
}

liveDescribe("durable import worker", () => {
  let fixture: ResearchFixture;

  beforeAll(() => {
    fixture = new ResearchFixture();
  });
  beforeEach(async () => fixture.reset());
  afterAll(async () => fixture.close());

  it("atomically composes a PERSON row with its facts", async () => {
    const actor = await fixture.createActor("owner");
    const referencedPerson = await fixture.createPerson(actor, {
      displayName: "Referenced Person",
    });
    const referencedPersonId = required(
      referencedPerson.body?.data?.createPerson?.person?.id,
    );
    const placeId = newId();
    await fixture.database.insert(places).values({
      id: placeId,
      workspaceId: actor.workspaceId,
      name: "Referenced Place",
      kind: "city",
      createdBy: actor.principalId,
      updatedBy: actor.principalId,
    });
    const fileId = newId();
    await fixture.database.insert(files).values({
      id: fileId,
      workspaceId: actor.workspaceId,
      storageProvider: "minio",
      storageBucket: "private",
      storageKey: `typed-facts/${fileId}`,
      originalName: "reference.txt",
      mediaType: "text/plain",
      detectedType: "text/plain",
      byteSize: 1,
      checksum: `sha256:${"71".repeat(32)}`,
      quarantineState: "available",
      scanState: "clean",
      ocrState: "not_requested",
      extractionState: "not_requested",
      uploadedBy: actor.userId,
      createdBy: actor.principalId,
      updatedBy: actor.principalId,
    });
    const factInputs = [
      ["text", "mathematician"],
      ["rich_text", "Line one\nLine two"],
      ["uri", "https://example.test/ada"],
      ["integer", 42],
      ["decimal", "12.50"],
      ["boolean", true],
      ["date", "2026-08-01"],
      ["date_range", { dateStart: "2026-08-01", dateEnd: "2026-08-31" }],
      ["timestamp", "2026-08-01T12:00:00Z"],
      ["duration", { decimal: "3", unit: "days" }],
      ["quantity", { decimal: "12.5", unit: "kg" }],
      ["json", { verified: true, score: 7 }],
      ["person_reference", referencedPersonId],
      ["place_reference", placeId],
      ["file_reference", fileId],
    ] as const;
    const definitions = factInputs.map(([type], index) => ({
      id: newId(),
      workspaceId: actor.workspaceId,
      namespace: "person",
      fieldKey: `typed_${index}_${type}`,
      label: `Typed ${type}`,
      allowedValueType: type,
      cardinality: "many" as const,
      defaultSensitivity: "internal" as const,
      state: "active" as const,
      createdBy: actor.principalId,
      updatedBy: actor.principalId,
    }));
    await fixture.database.insert(factDefinitions).values(definitions);
    const definitionId = definitions[0]!.id;
    const staged = await seedImport({
      actor,
      fixture,
      operation: "PERSON",
      payload: {
        kind: "PERSON",
        rowKey: "person-ada",
        person: {
          displayName: "Ada Lovelace",
          biography: "Mathematician",
        },
        primaryNameKind: "legal",
        facts: definitions.map((definition, index) => ({
          definitionId: definition.id,
          value: factInputs[index]![1],
        })),
        defaults: { sensitivity: "internal", status: "active" },
      },
    });

    await expect(
      runWorker(fixture, "019cc7c4-6ed2-7e0a-aed8-e5d451c96c01"),
    ).resolves.toMatchObject({ claimed: 1, completed: 1, deferred: 0 });
    const [person] = await fixture.database
      .select()
      .from(people)
      .where(eq(people.workspaceId, actor.workspaceId));
    expect(person).toMatchObject({
      displayName: "Ada Lovelace",
      biography: "Mathematician",
      createdBy: actor.principalId,
    });
    const storedFacts = await fixture.database
      .select()
      .from(facts)
      .where(eq(facts.personId, person!.id));
    expect(storedFacts).toHaveLength(factInputs.length);
    const fact = storedFacts.find(
      (candidate) => candidate.factDefinitionId === definitionId,
    );
    expect(fact).toMatchObject({
      factDefinitionId: definitionId,
      valueText: "mathematician",
      createdBy: actor.principalId,
    });
    expect(
      storedFacts.find((row) => row.valueType === "boolean"),
    ).toMatchObject({
      valueBoolean: true,
    });
    expect(
      storedFacts.find((row) => row.valueType === "date_range"),
    ).toMatchObject({
      valueDateStart: "2026-08-01",
      valueDateEnd: "2026-08-31",
    });
    expect(
      storedFacts.find((row) => row.valueType === "quantity"),
    ).toMatchObject({
      unit: "kg",
    });
    expect(storedFacts.find((row) => row.valueType === "json")).toMatchObject({
      valueJson: { verified: true, score: 7 },
    });
    expect(
      storedFacts.find((row) => row.valueType === "person_reference"),
    ).toMatchObject({ referencedPersonId });
    expect(
      storedFacts.find((row) => row.valueType === "place_reference"),
    ).toMatchObject({ placeId });
    expect(
      storedFacts.find((row) => row.valueType === "file_reference"),
    ).toMatchObject({ fileId });
    const [name] = await fixture.database
      .select()
      .from(personNames)
      .where(eq(personNames.personId, person!.id));
    const [external] = await fixture.database
      .select()
      .from(externalRecords)
      .where(eq(externalRecords.personId, person!.id));
    expect(person?.primaryNameId).toBe(name?.id);
    expect(name).toMatchObject({ kind: "legal", fullName: "Ada Lovelace" });
    expect(external).toMatchObject({
      importId: staged.importId,
      externalId: "person-ada",
      sourceHash: "52".repeat(31) + "01",
    });
    const [row] = await fixture.database
      .select()
      .from(importRows)
      .where(eq(importRows.id, staged.rowId));
    expect(row).toMatchObject({ state: "succeeded" });
    expect(new Set(row!.resultReferences as string[])).toEqual(
      new Set([
        person!.id,
        name!.id,
        external!.id,
        ...storedFacts.map(({ id }) => id),
      ]),
    );
    const [storedImport] = await fixture.database
      .select()
      .from(imports)
      .where(eq(imports.id, staged.importId));
    expect(storedImport).toMatchObject({
      state: "completed",
      acceptedRows: 1,
      rejectedRows: 0,
    });
    const systemActions = await fixture.database
      .select({ action: auditEvents.action })
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.workspaceId, actor.workspaceId),
          inArray(auditEvents.action, [
            "system.import.person.create",
            "system.import.personName.create",
            "system.import.externalRecord.create",
            "system.import.fact.create",
          ]),
        ),
      );
    expect(
      systemActions.filter(
        ({ action }) => action === "system.import.fact.create",
      ),
    ).toHaveLength(factInputs.length);
    expect(
      systemActions
        .filter(({ action }) => action !== "system.import.fact.create")
        .map(({ action }) => action)
        .sort(),
    ).toEqual([
      "system.import.externalRecord.create",
      "system.import.person.create",
      "system.import.personName.create",
    ]);
    const lifecycleActions = await fixture.database
      .select({ action: auditEvents.action })
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.resourceId, staged.importId),
          inArray(auditEvents.action, [
            "import.execution_started",
            "import.execution_finished",
          ]),
        ),
      );
    expect(lifecycleActions.map(({ action }) => action).sort()).toEqual([
      "import.execution_finished",
      "import.execution_started",
    ]);
  });

  it("executes a peer-created import under the initiating member authority", async () => {
    const owner = await fixture.createActor("owner");
    const member = await fixture.createWorkspaceMember(owner, "contributor");
    const staged = await seedImport({
      actor: owner,
      fixture,
      operation: "PERSON",
      payload: {
        kind: "PERSON",
        rowKey: "peer-authority",
        person: { displayName: "Peer Authority" },
        primaryNameKind: "legal",
        facts: [],
        defaults: {},
      },
    });
    await fixture.database
      .update(jobs)
      .set({ createdBy: member.userId, updatedBy: member.userId })
      .where(eq(jobs.id, staged.jobId));

    await expect(
      runWorker(fixture, "019cc7c4-6ed2-7e0a-aed8-e5d451c96c19"),
    ).resolves.toMatchObject({ claimed: 1, completed: 1, deadLettered: 0 });
    const [storedImport] = await fixture.database
      .select()
      .from(imports)
      .where(eq(imports.id, staged.importId));
    expect(storedImport).toMatchObject({
      createdBy: owner.userId,
      state: "completed",
    });
    const [person] = await fixture.database
      .select()
      .from(people)
      .where(eq(people.displayName, "Peer Authority"));
    expect(person).toMatchObject({ createdBy: member.principalId });
  });

  it("atomically executes a RELATIONSHIP row", async () => {
    const actor = await fixture.createActor("owner");
    const source = await fixture.createPerson(actor, {
      displayName: "Relationship Source",
    });
    const target = await fixture.createPerson(actor, {
      displayName: "Relationship Target",
    });
    const sourcePersonId = required(
      source.body?.data?.createPerson?.person?.id,
    );
    const targetPersonId = required(
      target.body?.data?.createPerson?.person?.id,
    );
    const relationshipTypeId = newId();
    await fixture.database.insert(relationshipTypes).values({
      id: relationshipTypeId,
      workspaceId: actor.workspaceId,
      namespace: "workspace",
      key: "colleague",
      forwardLabel: "colleague of",
      inverseLabel: "colleague of",
      directed: false,
      allowsSelf: false,
      allowedMultiplicity: "many_to_many",
      state: "active",
      createdBy: actor.principalId,
      updatedBy: actor.principalId,
    });
    const staged = await seedImport({
      actor,
      fixture,
      operation: "RELATIONSHIP",
      payload: {
        kind: "RELATIONSHIP",
        rowKey: "relationship-1",
        relationship: {
          typeId: relationshipTypeId,
          sourcePerson: { kind: "PERSON_ID", personId: sourcePersonId },
          targetPerson: { kind: "PERSON_ID", personId: targetPersonId },
          labelOverride: "worked with",
        },
        defaults: { sensitivity: "internal", state: "asserted" },
      },
    });

    await expect(
      runWorker(fixture, "019cc7c4-6ed2-7e0a-aed8-e5d451c96c02"),
    ).resolves.toMatchObject({ claimed: 1, completed: 1, deferred: 0 });
    const [relationship] = await fixture.database
      .select()
      .from(relationships)
      .where(eq(relationships.workspaceId, actor.workspaceId));
    expect(relationship).toMatchObject({
      sourcePersonId,
      targetPersonId,
      relationshipTypeId,
      labelOverride: "worked with",
      createdBy: actor.principalId,
    });
    const [row] = await fixture.database
      .select()
      .from(importRows)
      .where(eq(importRows.id, staged.rowId));
    expect(row).toMatchObject({
      state: "succeeded",
      resultReferences: [relationship!.id],
    });
    const [audit] = await fixture.database
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.resourceId, relationship!.id));
    expect(audit).toMatchObject({
      action: "system.import.relationship.create",
      actorUserId: null,
      sessionId: null,
      apiKeyId: null,
    });
  });

  it("resolves external relationship endpoints from two exact completed PERSON imports", async () => {
    const actor = await fixture.createActor("owner");
    const sourceImport = await seedImport({
      actor,
      fixture,
      operation: "PERSON",
      payload: {
        kind: "PERSON",
        rowKey: "external-source",
        person: { displayName: "External Source" },
        primaryNameKind: "legal",
        facts: [],
        defaults: {},
      },
    });
    const targetImport = await seedImport({
      actor,
      fixture,
      operation: "PERSON",
      payload: {
        kind: "PERSON",
        rowKey: "external-target",
        person: { displayName: "External Target" },
        primaryNameKind: "legal",
        facts: [],
        defaults: {},
      },
    });
    await expect(
      runWorker(fixture, "019cc7c4-6ed2-7e0a-aed8-e5d451c96c04"),
    ).resolves.toMatchObject({ claimed: 2, completed: 2 });
    const importedPeople = await fixture.database
      .select()
      .from(people)
      .where(eq(people.workspaceId, actor.workspaceId));
    const sourcePersonId = required(
      importedPeople.find((person) => person.displayName === "External Source")
        ?.id,
    );
    const targetPersonId = required(
      importedPeople.find((person) => person.displayName === "External Target")
        ?.id,
    );
    const relationshipTypeId = newId();
    await fixture.database.insert(relationshipTypes).values({
      id: relationshipTypeId,
      workspaceId: actor.workspaceId,
      namespace: "workspace",
      key: "external-colleague",
      forwardLabel: "colleague of",
      inverseLabel: "colleague of",
      directed: true,
      allowsSelf: false,
      allowedMultiplicity: "many_to_many",
      state: "active",
      createdBy: actor.principalId,
      updatedBy: actor.principalId,
    });
    const staged = await seedImport({
      actor,
      fixture,
      operation: "RELATIONSHIP",
      payload: {
        kind: "RELATIONSHIP",
        rowKey: "external-relationship",
        relationship: {
          typeId: relationshipTypeId,
          sourcePerson: {
            kind: "EXTERNAL_KEY",
            personImportId: sourceImport.importId,
            externalId: "external-source",
          },
          targetPerson: {
            kind: "EXTERNAL_KEY",
            personImportId: targetImport.importId,
            externalId: "external-target",
          },
        },
        defaults: {},
      },
    });
    await expect(
      runWorker(fixture, "019cc7c4-6ed2-7e0a-aed8-e5d451c96c05"),
    ).resolves.toMatchObject({ claimed: 1, completed: 1 });
    const [relationship] = await fixture.database
      .select()
      .from(relationships)
      .where(eq(relationships.workspaceId, actor.workspaceId));
    expect(relationship).toMatchObject({ sourcePersonId, targetPersonId });
    const [row] = await fixture.database
      .select()
      .from(importRows)
      .where(eq(importRows.id, staged.rowId));
    expect(row).toMatchObject({
      state: "succeeded",
      resultReferences: [relationship!.id],
    });
  });

  it("rejects an invalid row without dead-lettering the import job", async () => {
    const actor = await fixture.createActor("owner");
    const staged = await seedImport({
      actor,
      fixture,
      operation: "PERSON",
      payload: { kind: "PERSON", rowKey: "invalid-person" },
    });
    await expect(
      runWorker(fixture, "019cc7c4-6ed2-7e0a-aed8-e5d451c96c06"),
    ).resolves.toMatchObject({
      claimed: 1,
      completed: 1,
      deadLettered: 0,
    });
    const [row] = await fixture.database
      .select()
      .from(importRows)
      .where(eq(importRows.id, staged.rowId));
    expect(row).toMatchObject({
      state: "rejected",
      resultReferences: [],
      validationErrors: [
        {
          code: "INVALID_IMPORT_ROW",
          message: "The import row is invalid.",
        },
      ],
    });
    const [storedImport] = await fixture.database
      .select()
      .from(imports)
      .where(eq(imports.id, staged.importId));
    expect(storedImport).toMatchObject({
      state: "completed_with_errors",
      acceptedRows: 0,
      rejectedRows: 1,
    });
  });

  it("rolls back person identity and audits when a later fact is invalid", async () => {
    const actor = await fixture.createActor("owner");
    const definitionId = newId();
    await fixture.database.insert(factDefinitions).values({
      id: definitionId,
      workspaceId: actor.workspaceId,
      namespace: "person",
      fieldKey: "score",
      label: "Score",
      allowedValueType: "decimal",
      cardinality: "many",
      defaultSensitivity: "internal",
      state: "active",
      createdBy: actor.principalId,
      updatedBy: actor.principalId,
    });
    const staged = await seedImport({
      actor,
      fixture,
      operation: "PERSON",
      payload: {
        kind: "PERSON",
        rowKey: "invalid-fact-person",
        person: { displayName: "Invalid Fact Person" },
        primaryNameKind: "legal",
        facts: [{ definitionId, value: "not-a-decimal" }],
        defaults: {},
      },
    });
    await expect(
      runWorker(fixture, "019cc7c4-6ed2-7e0a-aed8-e5d451c96c07"),
    ).resolves.toMatchObject({ completed: 1, deadLettered: 0 });
    expect(await fixture.database.select().from(people)).toHaveLength(0);
    expect(await fixture.database.select().from(personNames)).toHaveLength(0);
    expect(await fixture.database.select().from(externalRecords)).toHaveLength(
      0,
    );
    expect(await fixture.database.select().from(facts)).toHaveLength(0);
    const domainAudits = await fixture.database
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.workspaceId, actor.workspaceId));
    expect(
      domainAudits.filter((audit) => audit.action.startsWith("system.import.")),
    ).toHaveLength(0);
    const [row] = await fixture.database
      .select()
      .from(importRows)
      .where(eq(importRows.id, staged.rowId));
    expect(row).toMatchObject({
      state: "rejected",
      validationErrors: [
        {
          code: "FACT_VALIDATION_FAILED",
          message: "The imported fact is invalid.",
        },
      ],
    });
  });

  it("traverses a DRY_RUN person row without persisting domain data", async () => {
    const actor = await fixture.createActor("owner");
    const staged = await seedImport({
      actor,
      fixture,
      mode: "DRY_RUN",
      operation: "PERSON",
      payload: {
        kind: "PERSON",
        rowKey: "dry-run-person",
        person: { displayName: "Dry Run Person" },
        primaryNameKind: "legal",
        facts: [],
        defaults: {},
      },
    });
    await expect(
      runWorker(fixture, "019cc7c4-6ed2-7e0a-aed8-e5d451c96c08"),
    ).resolves.toMatchObject({ completed: 1, deadLettered: 0 });
    expect(await fixture.database.select().from(people)).toHaveLength(0);
    expect(await fixture.database.select().from(personNames)).toHaveLength(0);
    expect(await fixture.database.select().from(externalRecords)).toHaveLength(
      0,
    );
    const [row] = await fixture.database
      .select()
      .from(importRows)
      .where(eq(importRows.id, staged.rowId));
    expect(row).toMatchObject({ state: "succeeded", resultReferences: [] });
    const [storedImport] = await fixture.database
      .select()
      .from(imports)
      .where(eq(imports.id, staged.importId));
    expect(storedImport).toMatchObject({ state: "completed", acceptedRows: 1 });
  });

  it("continues after a rejected row and completes mixed totals", async () => {
    const actor = await fixture.createActor("owner");
    const validPayload = {
      kind: "PERSON",
      rowKey: "mixed-valid-person",
      person: { displayName: "Mixed Valid Person" },
      primaryNameKind: "legal",
      facts: [],
      defaults: {},
    };
    const staged = await seedImport({
      actor,
      fixture,
      operation: "PERSON",
      payload: validPayload,
      payloads: [validPayload, { kind: "PERSON", rowKey: "mixed-invalid" }],
    });
    await expect(
      runWorker(fixture, "019cc7c4-6ed2-7e0a-aed8-e5d451c96c09"),
    ).resolves.toMatchObject({
      claimed: 1,
      completed: 1,
      deadLettered: 0,
    });
    const rows = await fixture.database
      .select()
      .from(importRows)
      .where(eq(importRows.importId, staged.importId));
    expect(rows.map((row) => row.state).sort()).toEqual([
      "rejected",
      "succeeded",
    ]);
    expect(await fixture.database.select().from(people)).toHaveLength(1);
    expect(await fixture.database.select().from(personNames)).toHaveLength(1);
    expect(await fixture.database.select().from(externalRecords)).toHaveLength(
      1,
    );
    const [storedImport] = await fixture.database
      .select()
      .from(imports)
      .where(eq(imports.id, staged.importId));
    expect(storedImport).toMatchObject({
      state: "completed_with_errors",
      acceptedRows: 1,
      rejectedRows: 1,
      totalRows: 2,
    });

    const succeededBeforeRetry = required(
      rows.find((row) => row.state === "succeeded"),
    );
    const rejectedBeforeRetry = required(
      rows.find((row) => row.state === "rejected"),
    );
    const retry = await (
      await importsServiceFor(fixture, actor)
    ).retryImport({
      importId: staged.importId,
      expectedVersion: storedImport!.version,
      idempotencyKey: "retry-mixed-import-v1",
    });
    expect(retry.import).toMatchObject({
      state: "queued",
      acceptedRows: 1,
      rejectedRows: 0,
      completedAt: null,
    });
    const retryRows = await fixture.database
      .select()
      .from(importRows)
      .where(eq(importRows.importId, staged.importId));
    expect(retryRows.find((row) => row.id === succeededBeforeRetry.id)).toEqual(
      succeededBeforeRetry,
    );
    expect(
      retryRows.find((row) => row.id === rejectedBeforeRetry.id),
    ).toMatchObject({
      state: "pending",
      resultReferences: [],
      validationErrors: [],
    });
    const replay = await (
      await importsServiceFor(fixture, actor)
    ).retryImport({
      importId: staged.importId,
      expectedVersion: storedImport!.version,
      idempotencyKey: "retry-mixed-import-v1",
    });
    expect(replay.job.id).toBe(retry.job.id);

    await fixture.database
      .update(jobs)
      .set({
        state: "queued",
        scheduledAt: new Date(Date.now() - 1_000),
        leaseOwner: null,
        leaseExpiresAt: null,
      })
      .where(inArray(jobs.id, [staged.jobId, retry.job.id]));
    await expect(
      runWorker(fixture, "019cc7c4-6ed2-7e0a-aed8-e5d451c96c12"),
    ).resolves.toMatchObject({
      claimed: 2,
      completed: 1,
      deadLettered: 1,
    });
    const [afterLateOldJob] = await fixture.database
      .select()
      .from(imports)
      .where(eq(imports.id, staged.importId));
    expect(afterLateOldJob).toMatchObject({
      state: "completed_with_errors",
      executionJobId: retry.job.id,
      acceptedRows: 1,
      rejectedRows: 1,
    });
    const retriedJobs = await fixture.database
      .select()
      .from(jobs)
      .where(inArray(jobs.id, [staged.jobId, retry.job.id]));
    expect(retriedJobs.find((job) => job.id === staged.jobId)?.state).toBe(
      "dead_letter",
    );
    expect(retriedJobs.find((job) => job.id === retry.job.id)?.state).toBe(
      "completed",
    );
    expect(await fixture.database.select().from(people)).toHaveLength(1);
  });

  it("executes 26 rows in bounded slices without spending the retry budget", async () => {
    const actor = await fixture.createActor("owner");
    const payloads = Array.from({ length: 26 }, (_, index) => ({
      kind: "PERSON",
      rowKey: `bounded-person-${index + 1}`,
      person: { displayName: `Bounded Person ${index + 1}` },
      primaryNameKind: "legal",
      facts: [],
      defaults: {},
    }));
    const staged = await seedImport({
      actor,
      fixture,
      operation: "PERSON",
      payload: payloads[0],
      payloads,
    });

    await expect(
      runWorker(fixture, "019cc7c4-6ed2-7e0a-aed8-e5d451c96c13"),
    ).resolves.toMatchObject({ claimed: 1, completed: 0, deferred: 1 });
    const [afterFirstSlice] = await fixture.database
      .select()
      .from(jobs)
      .where(eq(jobs.id, staged.jobId));
    expect(afterFirstSlice).toMatchObject({
      state: "queued",
      attemptCount: 0,
      claimGeneration: 1,
    });
    expect(await fixture.database.select().from(people)).toHaveLength(25);

    await expect(
      runWorker(fixture, "019cc7c4-6ed2-7e0a-aed8-e5d451c96c14"),
    ).resolves.toMatchObject({ claimed: 1, completed: 1, deferred: 0 });
    const [completedJob] = await fixture.database
      .select()
      .from(jobs)
      .where(eq(jobs.id, staged.jobId));
    expect(completedJob).toMatchObject({
      state: "completed",
      attemptCount: 1,
      claimGeneration: 2,
    });
    expect(await fixture.database.select().from(people)).toHaveLength(26);
    expect(await fixture.database.select().from(personNames)).toHaveLength(26);
    expect(await fixture.database.select().from(externalRecords)).toHaveLength(
      26,
    );
  });

  it("prepares, starts, and completes a header-only zero-row CSV", async () => {
    const actor = await fixture.createActor("owner");
    const body = new TextEncoder().encode("external_id,name\n");
    const fileId = newId();
    const objectKey = `header-only/${fileId}`;
    const checksum = `sha256:${"71".repeat(32)}`;
    await fixture.database.insert(files).values({
      id: fileId,
      workspaceId: actor.workspaceId,
      storageProvider: "minio",
      storageBucket: "private",
      storageKey: objectKey,
      originalName: "header-only.csv",
      mediaType: "text/csv",
      detectedType: "text/csv",
      byteSize: body.byteLength,
      checksum,
      quarantineState: "available",
      scanState: "not_required",
      ocrState: "not_requested",
      extractionState: "not_requested",
      uploadedBy: actor.userId,
      createdBy: actor.userId,
      updatedBy: actor.userId,
    });
    await fixture.database.insert(uploadSessions).values({
      id: newId(),
      workspaceId: actor.workspaceId,
      actorId: actor.userId,
      intendedPurpose: "CSV_IMPORT",
      originalName: "header-only.csv",
      maxBytes: body.byteLength,
      expectedChecksum: checksum,
      expectedMediaType: "text/csv",
      objectKey,
      state: "completed",
      expiresAt: new Date(Date.now() + 60_000),
      completedAt: new Date(),
      fileId,
      createdBy: actor.userId,
      updatedBy: actor.userId,
    });
    const service = await importsServiceFor(
      fixture,
      actor,
      new ImportObjectStore(actor.workspaceId, objectKey, body),
    );
    const mapping = await service.saveMapping({
      name: "Header-only people",
      format: "CSV",
      definition: {
        version: 1,
        recordKind: "PERSON",
        rowKeySource: "external_id",
        person: {
          displayNameSource: "name",
          primaryNameKind: "legal",
          fields: [],
        },
        facts: [],
        defaults: {},
      },
    });
    const prepared = await service.prepareImport({
      fileId,
      mappingId: mapping.mapping.id,
      idempotencyKey: "prepare-header-only-v1",
      mode: "COMMIT",
    });
    expect(prepared.import).toMatchObject({
      state: "preview_ready",
      totalRows: 0,
    });
    expect(prepared.preview).toEqual([]);
    expect(await fixture.database.select().from(importRows)).toHaveLength(0);
    const queued = await service.startImport({
      importId: prepared.import.id,
      expectedVersion: prepared.import.version,
      idempotencyKey: "run-header-only-v1",
    });

    await expect(
      runWorker(fixture, "019cc7c4-6ed2-7e0a-aed8-e5d451c96c15"),
    ).resolves.toMatchObject({ claimed: 1, completed: 1, deadLettered: 0 });
    const [storedImport] = await fixture.database
      .select()
      .from(imports)
      .where(eq(imports.id, queued.import.id));
    expect(storedImport).toMatchObject({
      state: "completed",
      totalRows: 0,
      acceptedRows: 0,
      rejectedRows: 0,
    });
  });

  it("recovers a stale PROCESSING row before executing it once", async () => {
    const actor = await fixture.createActor("owner");
    const staged = await seedImport({
      actor,
      fixture,
      importState: "running",
      operation: "PERSON",
      payload: {
        kind: "PERSON",
        rowKey: "stale-person",
        person: { displayName: "Recovered Person" },
        primaryNameKind: "legal",
        facts: [],
        defaults: {},
      },
      rowState: "processing",
      updatedAt: new Date(Date.now() - 120_000),
    });

    await expect(
      runWorker(fixture, "019cc7c4-6ed2-7e0a-aed8-e5d451c96c03"),
    ).resolves.toMatchObject({ claimed: 1, completed: 1, deferred: 0 });
    const storedPeople = await fixture.database
      .select()
      .from(people)
      .where(eq(people.workspaceId, actor.workspaceId));
    expect(storedPeople).toHaveLength(1);
    expect(storedPeople[0]?.displayName).toBe("Recovered Person");
    const [row] = await fixture.database
      .select()
      .from(importRows)
      .where(eq(importRows.id, staged.rowId));
    expect(row).toMatchObject({
      state: "succeeded",
    });
    expect(row?.resultReferences).toHaveLength(3);
    expect(row?.resultReferences).toContain(storedPeople[0]!.id);
  });

  it("fails the linked import instead of rewriting a declared-row invariant", async () => {
    const actor = await fixture.createActor("owner");
    const staged = await seedImport({
      actor,
      fixture,
      operation: "PERSON",
      payload: {
        kind: "PERSON",
        rowKey: "missing-row-person",
        person: { displayName: "Missing Row Person" },
        primaryNameKind: "legal",
        facts: [],
        defaults: {},
      },
    });
    await fixture.database
      .update(imports)
      .set({ totalRows: 2 })
      .where(eq(imports.id, staged.importId));
    await expect(
      runWorker(fixture, "019cc7c4-6ed2-7e0a-aed8-e5d451c96c10"),
    ).resolves.toMatchObject({ deadLettered: 1, completed: 0 });
    const [storedImport] = await fixture.database
      .select()
      .from(imports)
      .where(eq(imports.id, staged.importId));
    expect(storedImport).toMatchObject({
      state: "dead_letter",
      totalRows: 2,
      acceptedRows: 0,
      rejectedRows: 0,
    });
  });

  it("recovers a corrupt import payload from its unique execution-job link", async () => {
    const actor = await fixture.createActor("owner");
    const untouched = await seedFutureImport({
      actor,
      fixture,
      suffix: "corrupt-payload-control",
    });
    const staged = await seedImport({
      actor,
      fixture,
      operation: "PERSON",
      payload: {
        kind: "PERSON",
        rowKey: "corrupt-payload-person",
        person: { displayName: "Corrupt Payload Person" },
        primaryNameKind: "legal",
        facts: [],
        defaults: {},
      },
    });
    await fixture.database
      .update(jobs)
      .set({ attemptCount: 4, encryptedPayload: "corrupt" })
      .where(eq(jobs.id, staged.jobId));

    await expect(
      runWorker(fixture, "019cc7c4-6ed2-7e0a-aed8-e5d451c96c16"),
    ).resolves.toMatchObject({ claimed: 1, deadLettered: 1, completed: 0 });
    const [storedImport] = await fixture.database
      .select()
      .from(imports)
      .where(eq(imports.id, staged.importId));
    expect(storedImport).toMatchObject({
      state: "dead_letter",
      executionJobId: staged.jobId,
    });
    const [untouchedImport] = await fixture.database
      .select()
      .from(imports)
      .where(eq(imports.id, untouched.importId));
    expect(untouchedImport).toMatchObject({
      state: "queued",
      executionJobId: untouched.jobId,
    });
  });

  it("treats the unique execution-job link as authoritative over a mismatched payload", async () => {
    const actor = await fixture.createActor("owner");
    const untouched = await seedFutureImport({
      actor,
      fixture,
      suffix: "mismatched-payload-control",
    });
    const staged = await seedImport({
      actor,
      fixture,
      operation: "PERSON",
      payload: {
        kind: "PERSON",
        rowKey: "mismatched-payload-person",
        person: { displayName: "Mismatched Payload Person" },
        primaryNameKind: "legal",
        facts: [],
        defaults: {},
      },
    });
    const mismatched = encodeJobPayload({
      key: encryptionKey,
      payload: { kind: "import_execute", importId: newId() },
    });
    await fixture.database
      .update(jobs)
      .set({
        attemptCount: 4,
        encryptedPayload: mismatched.encryptedPayload,
        payloadHash: mismatched.payloadHash,
      })
      .where(eq(jobs.id, staged.jobId));

    await expect(
      runWorker(fixture, "019cc7c4-6ed2-7e0a-aed8-e5d451c96c17"),
    ).resolves.toMatchObject({ claimed: 1, deadLettered: 1, completed: 0 });
    const [storedImport] = await fixture.database
      .select()
      .from(imports)
      .where(eq(imports.id, staged.importId));
    expect(storedImport).toMatchObject({
      state: "dead_letter",
      executionJobId: staged.jobId,
    });
    const [untouchedImport] = await fixture.database
      .select()
      .from(imports)
      .where(eq(imports.id, untouched.importId));
    expect(untouchedImport).toMatchObject({
      state: "queued",
      executionJobId: untouched.jobId,
    });
  });

  it("does not rewrite a linked import when a corrupt file-cleanup job dies", async () => {
    const actor = await fixture.createActor("owner");
    const staged = await seedImport({
      actor,
      fixture,
      operation: "PERSON",
      payload: {
        kind: "PERSON",
        rowKey: "file-cleanup-isolation",
        person: { displayName: "File Cleanup Isolation" },
        primaryNameKind: "legal",
        facts: [],
        defaults: {},
      },
    });
    await fixture.database
      .update(jobs)
      .set({
        kind: "file_cleanup",
        attemptCount: 4,
        encryptedPayload: "corrupt",
      })
      .where(eq(jobs.id, staged.jobId));

    await expect(
      runWorker(fixture, "019cc7c4-6ed2-7e0a-aed8-e5d451c96c18"),
    ).resolves.toMatchObject({ claimed: 1, deadLettered: 1, completed: 0 });
    const [storedImport] = await fixture.database
      .select()
      .from(imports)
      .where(eq(imports.id, staged.importId));
    expect(storedImport).toMatchObject({
      state: "queued",
      executionJobId: staged.jobId,
    });
  });

  it("dead-letters an integrity failure and atomically fails only its linked import", async () => {
    const actor = await fixture.createActor("owner");
    const staged = await seedImport({
      actor,
      fixture,
      operation: "PERSON",
      payload: {
        kind: "PERSON",
        rowKey: "integrity-person",
        person: { displayName: "Integrity Person" },
        primaryNameKind: "legal",
        facts: [],
        defaults: {},
      },
    });
    await fixture.database
      .update(imports)
      .set({ mapping: { definition: { recordKind: "PERSON" } } })
      .where(eq(imports.id, staged.importId));
    await expect(
      runWorker(fixture, "019cc7c4-6ed2-7e0a-aed8-e5d451c96c11"),
    ).resolves.toMatchObject({ deadLettered: 1, completed: 0 });
    const [storedImport] = await fixture.database
      .select()
      .from(imports)
      .where(eq(imports.id, staged.importId));
    expect(storedImport).toMatchObject({ state: "dead_letter" });
    const [deadLetterAudit] = await fixture.database
      .select()
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.resourceId, staged.importId),
          eq(auditEvents.action, "import.dead_lettered"),
        ),
      );
    expect(deadLetterAudit).toMatchObject({
      outcome: "failure",
      redactedDiff: {
        errorCode: "forbidden",
        jobId: staged.jobId,
        state: "dead_letter",
      },
    });
  });
});
