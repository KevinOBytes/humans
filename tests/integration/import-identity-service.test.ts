// @vitest-environment node

import { count, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { newId } from "@/db/id";
import { files, importRows, imports } from "@/db/schema/files";
import { auditEvents, jobs } from "@/db/schema/operations";
import { externalRecords, people, personNames } from "@/db/schema/people";
import { runDurableImportRowResearchTransaction } from "@/modules/audit/transactions";
import { encodeJobPayload } from "@/modules/jobs/service";
import { createImportIdentityService } from "@/modules/people/import-identity-service";
import { createPeopleService } from "@/modules/people/service";
import { disabledSearchIndexMaintenance } from "@/modules/search/index-maintenance";

import type { SessionActor } from "../support/graphql";
import { ResearchFixture } from "../support/research-fixture";

const liveDescribe = process.env.TEST_DATABASE_URL ? describe : describe.skip;
const encryptionKey =
  "8e947ab119ee7657d188e7e0f4e2934fe665e3edcfbcb9d316d506910dbc8cba";

async function seedBinding(
  fixture: ResearchFixture,
  actor: SessionActor,
  operation: "PERSON" | "RELATIONSHIP" = "PERSON",
  identity: {
    displayName: string;
    primaryNameKind?:
      | "alias"
      | "birth"
      | "former"
      | "legal"
      | "married"
      | "other"
      | "preferred"
      | "transliteration";
    rowKey: string;
    sourceHash?: string;
    relationship?: {
      sourcePerson:
        | { kind: "PERSON_ID"; personId: string }
        | {
            externalId: string;
            kind: "EXTERNAL_KEY";
            personImportId: string;
          };
      targetPerson:
        | { kind: "PERSON_ID"; personId: string }
        | {
            externalId: string;
            kind: "EXTERNAL_KEY";
            personImportId: string;
          };
    };
  } = { displayName: "Test Person", rowKey: "test-person" },
) {
  const fileId = newId();
  const importId = newId();
  const rowId = newId();
  const jobId = newId();
  const leaseOwner = newId();
  const sourceHash =
    identity.sourceHash ??
    "4b86d9f92f33e82732f809a44ca26f3db816741762b1f0be5e05b64c9b87ad37";
  const relationshipTypeId = newId();
  const relationship =
    identity.relationship ??
    ({
      sourcePerson: { kind: "PERSON_ID", personId: newId() },
      targetPerson: { kind: "PERSON_ID", personId: newId() },
    } as const);
  const endpointMapping = (
    endpoint: (typeof relationship)["sourcePerson"],
    source: string,
  ) =>
    endpoint.kind === "EXTERNAL_KEY"
      ? {
          kind: "EXTERNAL_KEY" as const,
          personImportId: endpoint.personImportId,
          source,
        }
      : { kind: "PERSON_ID" as const, source };
  const encoded = encodeJobPayload({
    key: encryptionKey,
    payload: { kind: "import_execute", importId },
  });
  await fixture.database.insert(files).values({
    id: fileId,
    workspaceId: actor.workspaceId,
    storageProvider: "minio",
    storageBucket: "private",
    storageKey: `identity-test/${fileId}`,
    originalName: "identity.csv",
    mediaType: "text/csv",
    detectedType: "text/csv",
    byteSize: 1,
    checksum: `sha256:${"61".repeat(32)}`,
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
    mapping: {
      definition:
        operation === "PERSON"
          ? {
              version: 1,
              recordKind: "PERSON",
              rowKeySource: "external_id",
              person: {
                displayNameSource: "name",
                primaryNameKind: identity.primaryNameKind ?? "legal",
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
                typeId: relationshipTypeId,
                sourcePerson: endpointMapping(
                  relationship.sourcePerson,
                  "source_person",
                ),
                targetPerson: endpointMapping(
                  relationship.targetPerson,
                  "target_person",
                ),
                fields: [],
              },
              defaults: {},
            },
      mappingHash: "71".repeat(32),
      mappingId: newId(),
      mappingVersion: 1,
      mode: "COMMIT",
      requestHash: "72".repeat(32),
    },
    idempotencyKey: `identity-${importId}`,
    totalRows: 1,
    createdBy: actor.userId,
    updatedBy: actor.userId,
  });
  await fixture.database.insert(importRows).values({
    id: rowId,
    workspaceId: actor.workspaceId,
    importId,
    rowNumber: 1,
    sourceHash,
    normalizedPayload:
      operation === "PERSON"
        ? {
            kind: "PERSON",
            rowKey: identity.rowKey,
            person: { displayName: identity.displayName },
            primaryNameKind: identity.primaryNameKind ?? "legal",
            facts: [],
            defaults: {},
          }
        : {
            kind: "RELATIONSHIP",
            rowKey: identity.rowKey,
            relationship: {
              typeId: relationshipTypeId,
              sourcePerson: relationship.sourcePerson,
              targetPerson: relationship.targetPerson,
            },
            defaults: {},
          },
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
    idempotencyKey: `identity-job-${jobId}`,
    state: "running",
    attemptCount: 1,
    claimGeneration: 1,
    leaseOwner,
    leaseExpiresAt: new Date(Date.now() + 60_000),
    createdBy: actor.userId,
    updatedBy: actor.userId,
  });
  await fixture.database
    .update(imports)
    .set({ executionJobId: jobId })
    .where(eq(imports.id, importId));
  return {
    input: {
      encryptionKey,
      claimGeneration: 1,
      importRowId: rowId,
      jobId,
      leaseOwner,
      searchIndexMaintenance: disabledSearchIndexMaintenance,
      workspaceId: actor.workspaceId,
    },
    importId,
    rowId,
    sourceHash,
  };
}

function externalRelationshipIdentity(
  personImportId: string,
  externalId: string,
) {
  return {
    displayName: "Relationship Row",
    rowKey: `relationship-${externalId}`,
    relationship: {
      sourcePerson: {
        kind: "EXTERNAL_KEY" as const,
        personImportId,
        externalId,
      },
      targetPerson: { kind: "PERSON_ID" as const, personId: newId() },
    },
  };
}

async function tableCount(
  fixture: ResearchFixture,
  table: typeof people | typeof personNames | typeof externalRecords,
) {
  const [row] = await fixture.database.select({ value: count() }).from(table);
  return row?.value ?? 0;
}

liveDescribe("import identity service", () => {
  let fixture: ResearchFixture;

  beforeAll(() => {
    fixture = new ResearchFixture();
  });
  beforeEach(async () => fixture.reset());
  afterAll(async () => fixture.close());

  it("atomically creates one primary name and deterministic external record with exact replay", async () => {
    const actor = await fixture.createActor("owner");
    const binding = await seedBinding(fixture, actor, "PERSON", {
      displayName: "Ada Lovelace",
      rowKey: "ada-001",
    });
    const result = await runDurableImportRowResearchTransaction(
      fixture.database,
      binding.input,
      async ({ context }) => {
        const person = await createPeopleService(context).create({
          displayName: "Ada Lovelace",
        });
        if (!person.resource) throw new Error("Expected person creation");
        const identity = createImportIdentityService(context);
        const first = await identity.attachPersonIdentity({
          personId: person.resource.id,
        });
        const replay = await identity.attachPersonIdentity({
          personId: person.resource.id,
        });
        expect(replay).toEqual(first);
        return {
          resultReferences: [
            person.resource.id,
            first.personName.id,
            first.externalRecord.id,
          ],
          value: first,
        };
      },
    );
    expect(result.status).toBe("completed");
    expect(await tableCount(fixture, personNames)).toBe(1);
    expect(await tableCount(fixture, externalRecords)).toBe(1);
    const [person] = await fixture.database.select().from(people);
    const [name] = await fixture.database.select().from(personNames);
    const [external] = await fixture.database.select().from(externalRecords);
    expect(person).toMatchObject({
      primaryNameId: name?.id,
      version: 2,
      updatedBy: actor.principalId,
    });
    expect(name).toMatchObject({
      personId: person?.id,
      kind: "legal",
      fullName: "Ada Lovelace",
      createdBy: actor.principalId,
      updatedBy: actor.principalId,
    });
    expect(external).toMatchObject({
      personId: person?.id,
      importId: binding.importId,
      sourceSystem: `humans-import:${binding.importId}`,
      externalType: "person",
      externalId: "ada-001",
      sourceHash: binding.sourceHash,
      createdBy: actor.principalId,
      updatedBy: actor.principalId,
    });
    const audits = await fixture.database
      .select()
      .from(auditEvents)
      .where(
        inArray(auditEvents.action, [
          "system.import.personName.create",
          "system.import.externalRecord.create",
        ]),
      );
    expect(audits).toHaveLength(2);
    expect(audits.every((audit) => audit.actorUserId === null)).toBe(true);
    for (const audit of audits) {
      expect(audit.redactedDiff).toMatchObject({
        worker: {
          importId: binding.importId,
          importRowId: binding.rowId,
          jobId: binding.input.jobId,
        },
      });
    }
    const serialized = JSON.stringify(audits);
    expect(serialized).not.toContain("Ada Lovelace");
    expect(serialized).not.toContain("ada-001");
    expect(serialized).not.toContain(binding.sourceHash);
  });

  it("rolls back person, identity, external record, audits, and row finish on replay conflict", async () => {
    const actor = await fixture.createActor("owner");
    const binding = await seedBinding(fixture, actor, "PERSON", {
      displayName: "Conflict Person",
      rowKey: "conflict-001",
    });
    await expect(
      runDurableImportRowResearchTransaction(
        fixture.database,
        binding.input,
        async ({ context }) => {
          const person = await createPeopleService(context).create({
            displayName: "Conflict Person",
          });
          if (!person.resource) throw new Error("Expected person creation");
          const identity = createImportIdentityService(context);
          const attached = await identity.attachPersonIdentity({
            personId: person.resource.id,
          });
          await context.database
            .update(externalRecords)
            .set({
              sourceHash:
                "0aa359513c2054f16f8496ff46a4ca6cab5a2f21f074cf592535c8373b85f263",
            })
            .where(eq(externalRecords.id, attached.externalRecord.id));
          await identity.attachPersonIdentity({
            personId: person.resource.id,
          });
          return { resultReferences: [person.resource.id], value: null };
        },
      ),
    ).rejects.toMatchObject({ extensions: { code: "CONFLICT" } });
    expect(await tableCount(fixture, people)).toBe(0);
    expect(await tableCount(fixture, personNames)).toBe(0);
    expect(await tableCount(fixture, externalRecords)).toBe(0);
    const [auditCount] = await fixture.database
      .select({ value: count() })
      .from(auditEvents);
    expect(auditCount?.value).toBe(0);
    const [row] = await fixture.database
      .select()
      .from(importRows)
      .where(eq(importRows.id, binding.rowId));
    expect(row).toMatchObject({ state: "processing", resultReferences: [] });
  });

  it("returns a deterministic conflict for a soft-deleted unique external key", async () => {
    const actor = await fixture.createActor("owner");
    const binding = await seedBinding(fixture, actor, "PERSON", {
      displayName: "Deleted External Person",
      rowKey: "deleted-external-001",
    });
    await expect(
      runDurableImportRowResearchTransaction(
        fixture.database,
        binding.input,
        async ({ context }) => {
          const person = await createPeopleService(context).create({
            displayName: "Deleted External Person",
          });
          if (!person.resource) throw new Error("Expected person creation");
          const identity = createImportIdentityService(context);
          const attached = await identity.attachPersonIdentity({
            personId: person.resource.id,
          });
          await context.database
            .update(externalRecords)
            .set({ deletedAt: new Date(), deletedBy: actor.principalId })
            .where(eq(externalRecords.id, attached.externalRecord.id));
          await identity.attachPersonIdentity({
            personId: person.resource.id,
          });
          return { resultReferences: [], value: null };
        },
      ),
    ).rejects.toMatchObject({ extensions: { code: "CONFLICT" } });
    expect(await tableCount(fixture, people)).toBe(0);
    expect(await tableCount(fixture, personNames)).toBe(0);
    expect(await tableCount(fixture, externalRecords)).toBe(0);
  });

  it("rejects cross-row reuse of a person created earlier by the same job", async () => {
    const actor = await fixture.createActor("owner");
    const binding = await seedBinding(fixture, actor, "PERSON", {
      displayName: "Same Job Person",
      rowKey: "first-row",
    });
    const first = await runDurableImportRowResearchTransaction(
      fixture.database,
      binding.input,
      async ({ context }) => {
        const person = await createPeopleService(context).create({
          displayName: "Same Job Person",
        });
        if (!person.resource) throw new Error("Expected person creation");
        const identity = await createImportIdentityService(
          context,
        ).attachPersonIdentity({ personId: person.resource.id });
        return {
          resultReferences: [person.resource.id, identity.externalRecord.id],
          value: person.resource.id,
        };
      },
    );
    if (first.status !== "completed") throw new Error("Expected completion");

    const secondRowId = newId();
    await fixture.database.insert(importRows).values({
      id: secondRowId,
      workspaceId: actor.workspaceId,
      importId: binding.importId,
      rowNumber: 2,
      sourceHash:
        "0aa359513c2054f16f8496ff46a4ca6cab5a2f21f074cf592535c8373b85f263",
      normalizedPayload: {
        kind: "PERSON",
        rowKey: "second-row",
        person: { displayName: "Same Job Person" },
        primaryNameKind: "legal",
        facts: [],
        defaults: {},
      },
      state: "processing",
      createdBy: actor.userId,
      updatedBy: actor.userId,
    });
    await expect(
      runDurableImportRowResearchTransaction(
        fixture.database,
        { ...binding.input, importRowId: secondRowId },
        async ({ context }) => {
          await createImportIdentityService(context).attachPersonIdentity({
            personId: first.value,
          });
          return { resultReferences: [], value: null };
        },
      ),
    ).rejects.toMatchObject({ extensions: { code: "NOT_FOUND" } });
    const [secondRow] = await fixture.database
      .select()
      .from(importRows)
      .where(eq(importRows.id, secondRowId));
    expect(secondRow).toMatchObject({ state: "processing" });
    expect(await tableCount(fixture, people)).toBe(1);
    expect(await tableCount(fixture, externalRecords)).toBe(1);
  });

  it("rejects staged name identity that disagrees with the locked mapping", async () => {
    const actor = await fixture.createActor("owner");
    const binding = await seedBinding(fixture, actor, "PERSON", {
      displayName: "Mismatched Mapping Person",
      primaryNameKind: "alias",
      rowKey: "mapping-mismatch",
    });
    await fixture.database
      .update(imports)
      .set({
        mapping: {
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
          mappingHash: "73".repeat(32),
          mappingId: newId(),
          mappingVersion: 1,
          mode: "COMMIT",
          requestHash: "74".repeat(32),
        },
      })
      .where(eq(imports.id, binding.importId));
    await expect(
      runDurableImportRowResearchTransaction(
        fixture.database,
        binding.input,
        async ({ context }) => {
          const person = await createPeopleService(context).create({
            displayName: "Mismatched Mapping Person",
          });
          if (!person.resource) throw new Error("Expected person creation");
          await createImportIdentityService(context).attachPersonIdentity({
            personId: person.resource.id,
          });
          return { resultReferences: [], value: null };
        },
      ),
    ).rejects.toMatchObject({ extensions: { code: "NOT_FOUND" } });
    expect(await tableCount(fixture, people)).toBe(0);
    expect(await tableCount(fixture, personNames)).toBe(0);
    expect(await tableCount(fixture, externalRecords)).toBe(0);
  });

  it("rejects missing, cross-workspace, and existing people but attaches a just-created restricted person", async () => {
    const actor = await fixture.createActor("owner");
    const foreignActor = await fixture.createActor("owner");
    const existingPerson = await fixture.createPerson(actor, {
      displayName: "Existing Person",
    });
    const existingPersonId =
      existingPerson.body?.data?.createPerson?.person?.id;
    if (!existingPersonId) throw new Error("Expected existing person");
    const foreignPerson = await fixture.createPerson(foreignActor, {
      displayName: "Foreign Person",
    });
    const foreignPersonId = foreignPerson.body?.data?.createPerson?.person?.id;
    if (!foreignPersonId) throw new Error("Expected foreign person");

    for (const personId of [newId(), existingPersonId, foreignPersonId]) {
      const binding = await seedBinding(fixture, actor);
      await expect(
        runDurableImportRowResearchTransaction(
          fixture.database,
          binding.input,
          ({ context }) =>
            createImportIdentityService(context)
              .attachPersonIdentity({
                personId,
              })
              .then((value) => ({
                resultReferences: [value.personName.id],
                value,
              })),
        ),
      ).rejects.toMatchObject({ extensions: { code: "NOT_FOUND" } });
    }

    const restrictedBinding = await seedBinding(fixture, actor, "PERSON", {
      displayName: "Restricted Person",
      rowKey: "restricted-001",
    });
    const restricted = await runDurableImportRowResearchTransaction(
      fixture.database,
      restrictedBinding.input,
      async ({ context }) => {
        const person = await createPeopleService(context).create({
          displayName: "Restricted Person",
          sensitivity: "restricted",
        });
        if (!person.resource) throw new Error("Expected person creation");
        const value = await createImportIdentityService(
          context,
        ).attachPersonIdentity({
          personId: person.resource.id,
        });
        return {
          resultReferences: [person.resource.id, value.personName.id],
          value: person.resource.id,
        };
      },
    );
    expect(restricted.status).toBe("completed");
    expect(await tableCount(fixture, personNames)).toBe(1);
    expect(await tableCount(fixture, externalRecords)).toBe(1);
    const localPeople = await fixture.database
      .select()
      .from(people)
      .where(eq(people.workspaceId, actor.workspaceId));
    expect(localPeople.map((person) => person.id).sort()).toEqual(
      [existingPersonId, restricted.value].sort(),
    );

    await fixture.database
      .update(imports)
      .set({ state: "completed", completedAt: new Date() })
      .where(eq(imports.id, restrictedBinding.importId));
    const relationshipBinding = await seedBinding(
      fixture,
      actor,
      "RELATIONSHIP",
      externalRelationshipIdentity(
        restrictedBinding.importId,
        "restricted-001",
      ),
    );
    const unresolved = await runDurableImportRowResearchTransaction(
      fixture.database,
      relationshipBinding.input,
      async ({ context }) => ({
        resultReferences: [],
        value: await createImportIdentityService(
          context,
        ).resolveRelationshipPerson({ endpoint: "source" }),
      }),
    );
    expect(unresolved).toMatchObject({ status: "completed", value: null });
  });

  it("accepts a 512-byte external key and rejects oversized or unsafe keys", async () => {
    const actor = await fixture.createActor("owner");
    const boundaryKey = "é".repeat(256);
    const boundaryBinding = await seedBinding(fixture, actor, "PERSON", {
      displayName: "Boundary Person",
      rowKey: boundaryKey,
    });
    const boundary = await runDurableImportRowResearchTransaction(
      fixture.database,
      boundaryBinding.input,
      async ({ context }) => {
        const person = await createPeopleService(context).create({
          displayName: "Boundary Person",
        });
        if (!person.resource) throw new Error("Expected person creation");
        const identity = await createImportIdentityService(
          context,
        ).attachPersonIdentity({
          personId: person.resource.id,
        });
        return {
          resultReferences: [identity.externalRecord.id],
          value: identity.externalRecord.externalId,
        };
      },
    );
    expect(boundary).toMatchObject({ status: "completed", value: boundaryKey });

    for (const unsafeKey of [
      "a".repeat(513),
      "control\u0001key",
      "bidi\u202ekey",
    ]) {
      const binding = await seedBinding(fixture, actor, "PERSON", {
        displayName: "Rejected Key Person",
        rowKey: unsafeKey,
      });
      await expect(
        runDurableImportRowResearchTransaction(
          fixture.database,
          binding.input,
          async ({ context }) => {
            const person = await createPeopleService(context).create({
              displayName: "Rejected Key Person",
            });
            if (!person.resource) throw new Error("Expected person creation");
            await createImportIdentityService(context).attachPersonIdentity({
              personId: person.resource.id,
            });
            return { resultReferences: [], value: null };
          },
        ),
      ).rejects.toMatchObject({
        extensions: { code: "VALIDATION_FAILED" },
      });
    }
  });

  it("rejects identity operations under the wrong trusted worker capability", async () => {
    const actor = await fixture.createActor("owner");
    const relationshipBinding = await seedBinding(
      fixture,
      actor,
      "RELATIONSHIP",
    );
    await expect(
      runDurableImportRowResearchTransaction(
        fixture.database,
        relationshipBinding.input,
        async ({ context }) => {
          await createImportIdentityService(context).attachPersonIdentity({
            personId: newId(),
          });
          return { resultReferences: [], value: null };
        },
      ),
    ).rejects.toMatchObject({ extensions: { code: "FORBIDDEN" } });

    const personBinding = await seedBinding(fixture, actor);
    await expect(
      runDurableImportRowResearchTransaction(
        fixture.database,
        personBinding.input,
        async ({ context }) => {
          await createImportIdentityService(context).resolveRelationshipPerson({
            endpoint: "source",
          });
          return { resultReferences: [], value: null };
        },
      ),
    ).rejects.toMatchObject({ extensions: { code: "FORBIDDEN" } });
  });

  it("resolves only visible keys from a completed PERSON import in the same workspace", async () => {
    const actor = await fixture.createActor("owner");
    const personBinding = await seedBinding(fixture, actor, "PERSON", {
      displayName: "Resolvable Person",
      rowKey: "resolve-001",
    });
    const created = await runDurableImportRowResearchTransaction(
      fixture.database,
      personBinding.input,
      async ({ context }) => {
        const person = await createPeopleService(context).create({
          displayName: "Resolvable Person",
        });
        if (!person.resource) throw new Error("Expected person creation");
        const identity = await createImportIdentityService(
          context,
        ).attachPersonIdentity({
          personId: person.resource.id,
        });
        return {
          resultReferences: [person.resource.id, identity.externalRecord.id],
          value: person.resource.id,
        };
      },
    );
    if (created.status !== "completed") throw new Error("Expected completion");
    const personId = created.value;

    const runningRelationship = await seedBinding(
      fixture,
      actor,
      "RELATIONSHIP",
      externalRelationshipIdentity(personBinding.importId, "resolve-001"),
    );
    const beforeCompletion = await runDurableImportRowResearchTransaction(
      fixture.database,
      runningRelationship.input,
      async ({ context }) => ({
        resultReferences: [],
        value: await createImportIdentityService(
          context,
        ).resolveRelationshipPerson({ endpoint: "source" }),
      }),
    );
    expect(beforeCompletion).toMatchObject({
      status: "completed",
      value: null,
    });

    await fixture.database
      .update(imports)
      .set({ state: "completed", completedAt: new Date() })
      .where(eq(imports.id, personBinding.importId));
    const completedRelationship = await seedBinding(
      fixture,
      actor,
      "RELATIONSHIP",
      externalRelationshipIdentity(personBinding.importId, "resolve-001"),
    );
    const visible = await runDurableImportRowResearchTransaction(
      fixture.database,
      completedRelationship.input,
      async ({ context }) => {
        const resolved = await createImportIdentityService(
          context,
        ).resolveRelationshipPerson({ endpoint: "source" });
        return {
          resultReferences: resolved ? [resolved] : [],
          value: resolved,
        };
      },
    );
    expect(visible).toMatchObject({ status: "completed", value: personId });

    const hiddenRelationship = await seedBinding(
      fixture,
      actor,
      "RELATIONSHIP",
      externalRelationshipIdentity(personBinding.importId, "resolve-001"),
    );
    let markElevationStarted!: () => void;
    let releaseElevation!: () => void;
    const elevationStarted = new Promise<void>((resolve) => {
      markElevationStarted = resolve;
    });
    const elevationRelease = new Promise<void>((resolve) => {
      releaseElevation = resolve;
    });
    const elevation = fixture.database.transaction(async (transaction) => {
      await transaction
        .update(people)
        .set({ sensitivity: "restricted" })
        .where(eq(people.id, personId));
      markElevationStarted();
      await elevationRelease;
    });
    await elevationStarted;
    let resolutionSettled = false;
    const hiddenPromise = runDurableImportRowResearchTransaction(
      fixture.database,
      hiddenRelationship.input,
      async ({ context }) => ({
        resultReferences: [],
        value: await createImportIdentityService(
          context,
        ).resolveRelationshipPerson({ endpoint: "source" }),
      }),
    ).finally(() => {
      resolutionSettled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    const leakedBeforeElevationCommit = resolutionSettled;
    releaseElevation();
    await elevation;
    const hidden = await hiddenPromise;
    expect(leakedBeforeElevationCommit).toBe(false);
    expect(hidden).toMatchObject({ status: "completed", value: null });

    const foreignActor = await fixture.createActor("owner");
    const foreignRelationship = await seedBinding(
      fixture,
      foreignActor,
      "RELATIONSHIP",
      externalRelationshipIdentity(personBinding.importId, "resolve-001"),
    );
    const foreign = await runDurableImportRowResearchTransaction(
      fixture.database,
      foreignRelationship.input,
      async ({ context }) => ({
        resultReferences: [],
        value: await createImportIdentityService(
          context,
        ).resolveRelationshipPerson({ endpoint: "source" }),
      }),
    );
    expect(foreign).toMatchObject({ status: "completed", value: null });
  });
});
