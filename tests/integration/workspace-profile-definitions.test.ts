// @vitest-environment node

import { and, eq } from "drizzle-orm";
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
import { caseResourceLinks, cases } from "@/db/schema/cases";
import { auditEvents } from "@/db/schema/operations";
import { factDefinitions, factRevisions, facts } from "@/db/schema/facts";
import { people } from "@/db/schema/people";
import {
  CreateFactDocument,
  FactCatalogDocument,
  PersonHeaderDocument,
} from "@/graphql/generated/graphql";
import { backfillWorkspaceProfileDefinitions } from "@/modules/auth/workspace-profile-definitions";
import type { SearchIndexMaintenance } from "@/modules/search/index-maintenance";

import { ResearchFixture } from "../support/research-fixture";

const liveDescribe = process.env.TEST_DATABASE_URL ? describe : describe.skip;

function required<T>(value: T | null | undefined): T {
  if (value == null) throw new Error("Required fixture value is missing");
  return value;
}

liveDescribe("workspace rich-profile fact catalog", () => {
  let fixture: ResearchFixture;
  let initialized = false;
  const applySearchIndex = vi.fn<SearchIndexMaintenance["apply"]>(
    async () => undefined,
  );

  beforeAll(() => {
    fixture = new ResearchFixture({
      searchIndexMaintenance: {
        mode: "transactional",
        apply: applySearchIndex,
      },
    });
    initialized = true;
  });

  beforeEach(async () => {
    await fixture.reset();
    applySearchIndex.mockClear();
  });

  afterAll(async () => {
    if (initialized) await fixture.close();
  });

  it("provisions the documented profile fields for each new workspace", async () => {
    const actor = await fixture.createActor();
    const response = await fixture.execute<{
      factDefinitions: {
        nodes: Array<{
          namespace: string;
          fieldKey: string;
          label: string;
          category: string | null;
          allowedValueType: string;
          cardinality: string;
          defaultSensitivity: string;
          state: string;
        }>;
      };
    }>({
      jar: actor.jar,
      operationName: "FactCatalog",
      query: FactCatalogDocument,
      variables: { first: 20 },
    });

    expect(response.body?.errors).toBeUndefined();
    expect(response.body?.data?.factDefinitions.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          namespace: "profile",
          fieldKey: "pronouns",
          label: "Pronouns",
          category: "identity",
          allowedValueType: "TEXT",
          cardinality: "MANY",
          defaultSensitivity: "INTERNAL",
          state: "ACTIVE",
        }),
        expect.objectContaining({
          namespace: "profile",
          fieldKey: "employment",
          allowedValueType: "TEXT",
          cardinality: "MANY",
          state: "ACTIVE",
        }),
        expect.objectContaining({
          namespace: "profile",
          fieldKey: "education",
          allowedValueType: "TEXT",
          cardinality: "MANY",
          state: "ACTIVE",
        }),
        expect.objectContaining({
          namespace: "profile",
          fieldKey: "language",
          allowedValueType: "TEXT",
          cardinality: "MANY",
          state: "ACTIVE",
        }),
        expect.objectContaining({
          namespace: "profile",
          fieldKey: "organization",
          allowedValueType: "TEXT",
          cardinality: "MANY",
          state: "ACTIVE",
        }),
        expect.objectContaining({
          namespace: "profile",
          fieldKey: "birth_date",
          allowedValueType: "DATE",
          cardinality: "ONE",
          defaultSensitivity: "CONFIDENTIAL",
          state: "ACTIVE",
        }),
        expect.objectContaining({
          namespace: "profile",
          fieldKey: "person_reference",
          allowedValueType: "PERSON_REFERENCE",
          cardinality: "MANY",
          defaultSensitivity: "INTERNAL",
          state: "ACTIVE",
        }),
        expect.objectContaining({
          namespace: "profile",
          fieldKey: "custom_note",
          allowedValueType: "JSON",
          cardinality: "MANY",
          state: "ACTIVE",
        }),
      ]),
    );
    const provisioningAudits = await fixture.database
      .select({ action: auditEvents.action })
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.workspaceId, actor.workspaceId),
          eq(auditEvents.action, "factDefinition.catalogBackfill"),
          eq(auditEvents.requestId, `workspace-provision:${actor.workspaceId}`),
        ),
      );
    expect(provisioningAudits).toEqual([
      { action: "factDefinition.catalogBackfill" },
    ]);
  });

  it("creates only person-reference facts whose targets the contributor can read", async () => {
    const owner = await fixture.createActor();
    const foreignOwner = await fixture.createActor();
    const contributor = await fixture.createWorkspaceMember(
      owner,
      "contributor",
    );
    const subject = await fixture.createPerson(owner, {
      displayName: "Reference subject",
    });
    const permitted = await fixture.createPerson(owner, {
      displayName: "Permitted reference",
    });
    const hidden = await fixture.createPerson(owner, {
      displayName: "Hidden confidential reference",
    });
    const caseHidden = await fixture.createPerson(owner, {
      displayName: "Hidden case reference",
    });
    const foreign = await fixture.createPerson(foreignOwner, {
      displayName: "Foreign workspace reference",
    });
    const subjectId = required(subject.body?.data?.createPerson?.person?.id);
    const permittedId = required(
      permitted.body?.data?.createPerson?.person?.id,
    );
    const hiddenId = required(hidden.body?.data?.createPerson?.person?.id);
    const caseHiddenId = required(
      caseHidden.body?.data?.createPerson?.person?.id,
    );
    const foreignId = required(foreign.body?.data?.createPerson?.person?.id);
    await fixture.database
      .update(people)
      .set({ sensitivity: "confidential" })
      .where(eq(people.id, hiddenId));
    const hiddenCaseId = newId();
    await fixture.database.insert(cases).values({
      id: hiddenCaseId,
      workspaceId: owner.workspaceId,
      title: "Hidden person-reference case",
      purpose: "Restricted case membership",
      createdBy: owner.principalId,
      updatedBy: owner.principalId,
    });
    await fixture.database.insert(caseResourceLinks).values({
      id: newId(),
      workspaceId: owner.workspaceId,
      caseId: hiddenCaseId,
      resourceKind: "person",
      resourceId: caseHiddenId,
      createdBy: owner.principalId,
      updatedBy: owner.principalId,
    });

    const catalog = await fixture.execute<{
      factDefinitions: { nodes: Array<{ id: string; fieldKey: string }> };
    }>({
      jar: contributor.jar,
      operationName: "FactCatalog",
      query: FactCatalogDocument,
      variables: { first: 20 },
    });
    const definitionId = required(
      catalog.body?.data?.factDefinitions.nodes.find(
        ({ fieldKey }) => fieldKey === "person_reference",
      )?.id,
    );
    for (const hiddenTargetId of [hiddenId, caseHiddenId, foreignId]) {
      const hiddenRead = await fixture.execute<{
        person: { id: string } | null;
      }>({
        jar: contributor.jar,
        operationName: "PersonHeader",
        query: PersonHeaderDocument,
        variables: { id: hiddenTargetId },
      });
      expect(hiddenRead.body?.errors).toBeUndefined();
      expect(hiddenRead.body?.data?.person).toBeNull();
    }

    const createReference = (referencedPersonId: string) =>
      fixture.execute<{
        createFact: {
          code: string | null;
          issues: Array<{ code: string; path: string[] }>;
          fact: { id: string } | null;
        };
      }>({
        jar: contributor.jar,
        operationName: "CreateFact",
        query: CreateFactDocument,
        variables: {
          input: {
            definitionId,
            personId: subjectId,
            value: { referencedPersonId },
          },
        },
      });

    const permittedResult = await createReference(permittedId);
    expect(permittedResult.body?.errors).toBeUndefined();
    expect(permittedResult.body?.data?.createFact).toMatchObject({
      code: null,
      issues: [],
      fact: { value: { referencedPersonId: permittedId } },
    });
    applySearchIndex.mockClear();

    for (const hiddenTargetId of [hiddenId, caseHiddenId, foreignId]) {
      applySearchIndex.mockClear();
      const hiddenResult = await createReference(hiddenTargetId);
      expect(hiddenResult.body?.errors).toBeUndefined();
      expect(hiddenResult.body?.data?.createFact).toMatchObject({
        code: "VALIDATION_FAILED",
        issues: [{ code: "NOT_FOUND", path: ["value"] }],
        fact: null,
      });
      expect(applySearchIndex).not.toHaveBeenCalled();
    }

    const createdFacts = await fixture.database
      .select({ id: facts.id, referencedPersonId: facts.referencedPersonId })
      .from(facts)
      .where(eq(facts.personId, subjectId));
    expect(createdFacts).toEqual([
      expect.objectContaining({ referencedPersonId: permittedId }),
    ]);
    expect(
      await fixture.database
        .select({ id: factRevisions.id })
        .from(factRevisions)
        .where(eq(factRevisions.factId, createdFacts[0]!.id)),
    ).toHaveLength(1);
    expect(
      await fixture.database
        .select({ id: auditEvents.id })
        .from(auditEvents)
        .where(
          and(
            eq(auditEvents.workspaceId, owner.workspaceId),
            eq(auditEvents.action, "fact.create"),
          ),
        ),
    ).toHaveLength(1);
  });

  it("backfills only missing catalog rows and records one idempotent audit", async () => {
    const actor = await fixture.createActor();
    const customId = newId();
    const preservedId = newId();
    await fixture.database
      .delete(factDefinitions)
      .where(
        and(
          eq(factDefinitions.workspaceId, actor.workspaceId),
          eq(factDefinitions.fieldKey, "employment"),
        ),
      );
    await fixture.database
      .delete(factDefinitions)
      .where(
        and(
          eq(factDefinitions.workspaceId, actor.workspaceId),
          eq(factDefinitions.fieldKey, "person_reference"),
        ),
      );
    await fixture.database
      .update(factDefinitions)
      .set({
        id: preservedId,
        label: "Workspace pronoun terminology",
        version: 7,
      })
      .where(
        and(
          eq(factDefinitions.workspaceId, actor.workspaceId),
          eq(factDefinitions.namespace, "profile"),
          eq(factDefinitions.fieldKey, "pronouns"),
        ),
      );
    await fixture.database.insert(factDefinitions).values({
      id: customId,
      workspaceId: actor.workspaceId,
      namespace: "custom",
      fieldKey: "research_interest",
      label: "Research interest",
      allowedValueType: "text",
      cardinality: "many",
      state: "active",
      version: 4,
      createdBy: actor.principalId,
      updatedBy: actor.principalId,
    });

    const first = await backfillWorkspaceProfileDefinitions(fixture.database, {
      workspaceId: actor.workspaceId,
      actorId: actor.principalId,
      requestId: "profile-backfill-test",
    });
    const second = await backfillWorkspaceProfileDefinitions(fixture.database, {
      workspaceId: actor.workspaceId,
      actorId: actor.principalId,
      requestId: "profile-backfill-test-replay",
    });

    expect(first.inserted.map(({ fieldKey }) => fieldKey).sort()).toEqual([
      "employment",
      "person_reference",
    ]);
    expect(second.inserted).toEqual([]);
    const rows = await fixture.database
      .select()
      .from(factDefinitions)
      .where(eq(factDefinitions.workspaceId, actor.workspaceId));
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          fieldKey: "employment",
          version: 1,
          createdBy: actor.principalId,
          updatedBy: actor.principalId,
        }),
        expect.objectContaining({
          id: preservedId,
          namespace: "profile",
          fieldKey: "pronouns",
          label: "Workspace pronoun terminology",
          version: 7,
        }),
        expect.objectContaining({
          id: customId,
          namespace: "custom",
          fieldKey: "research_interest",
          label: "Research interest",
          version: 4,
        }),
      ]),
    );
    const audits = await fixture.database
      .select()
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.workspaceId, actor.workspaceId),
          eq(auditEvents.action, "factDefinition.catalogBackfill"),
          eq(auditEvents.requestId, "profile-backfill-test"),
        ),
      );
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      requestId: "profile-backfill-test",
      resourceKind: "factDefinitionCatalog",
      outcome: "success",
    });
    expect(audits[0]?.redactedDiff).toEqual({
      changedFields: ["definitions"],
      metadata: {
        catalogVersion: 1,
        insertedCount: 2,
      },
    });
  });

  it("serializes concurrent catalog claims without duplicate rows or audits", async () => {
    const actor = await fixture.createActor();
    await fixture.database
      .delete(factDefinitions)
      .where(eq(factDefinitions.workspaceId, actor.workspaceId));

    const results = await Promise.all([
      backfillWorkspaceProfileDefinitions(fixture.database, {
        workspaceId: actor.workspaceId,
        actorId: actor.principalId,
        requestId: "concurrent-profile-backfill-a",
      }),
      backfillWorkspaceProfileDefinitions(fixture.database, {
        workspaceId: actor.workspaceId,
        actorId: actor.principalId,
        requestId: "concurrent-profile-backfill-b",
      }),
    ]);

    expect(results.map(({ inserted }) => inserted.length).sort()).toEqual([
      0, 8,
    ]);
    expect(
      await fixture.database
        .select({ id: factDefinitions.id })
        .from(factDefinitions)
        .where(eq(factDefinitions.workspaceId, actor.workspaceId)),
    ).toHaveLength(8);
    const concurrentAudits = (
      await fixture.database
        .select({ requestId: auditEvents.requestId })
        .from(auditEvents)
        .where(
          and(
            eq(auditEvents.workspaceId, actor.workspaceId),
            eq(auditEvents.action, "factDefinition.catalogBackfill"),
          ),
        )
    ).filter(({ requestId }) => requestId.startsWith("concurrent-"));
    expect(concurrentAudits).toHaveLength(1);
  });

  it("rejects a foreign-workspace actor without inserting rows", async () => {
    const actor = await fixture.createActor();
    const foreign = await fixture.createActor();
    await fixture.database
      .delete(factDefinitions)
      .where(
        and(
          eq(factDefinitions.workspaceId, actor.workspaceId),
          eq(factDefinitions.fieldKey, "employment"),
        ),
      );

    await expect(
      backfillWorkspaceProfileDefinitions(fixture.database, {
        workspaceId: actor.workspaceId,
        actorId: foreign.principalId,
        requestId: "foreign-profile-backfill-test",
      }),
    ).rejects.toThrow("workspace principal");
    const [employment] = await fixture.database
      .select({ id: factDefinitions.id })
      .from(factDefinitions)
      .where(
        and(
          eq(factDefinitions.workspaceId, actor.workspaceId),
          eq(factDefinitions.fieldKey, "employment"),
        ),
      );
    expect(employment).toBeUndefined();
  });
});
