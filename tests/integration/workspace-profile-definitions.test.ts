// @vitest-environment node

import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { newId } from "@/db/id";
import { auditEvents } from "@/db/schema/operations";
import { factDefinitions } from "@/db/schema/facts";
import { FactCatalogDocument } from "@/graphql/generated/graphql";
import { backfillWorkspaceProfileDefinitions } from "@/modules/auth/workspace-profile-definitions";

import { ResearchFixture } from "../support/research-fixture";

const liveDescribe = process.env.TEST_DATABASE_URL ? describe : describe.skip;

liveDescribe("workspace rich-profile fact catalog", () => {
  let fixture: ResearchFixture;
  let initialized = false;

  beforeAll(() => {
    fixture = new ResearchFixture();
    initialized = true;
  });

  beforeEach(async () => fixture.reset());

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
