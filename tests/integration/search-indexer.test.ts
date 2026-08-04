// @vitest-environment node

import { and, count, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { searchDocuments } from "@/db/schema/search";
import { newId } from "@/db/id";
import {
  evidenceExcerpts,
  evidenceItems,
  notes,
  personAddresses,
  sources,
} from "@/db/schema/evidence";
import { factDefinitions, facts } from "@/db/schema/facts";
import { addresses } from "@/db/schema/locations";
import { relationshipTypes, relationships } from "@/db/schema/relationships";
import {
  createSearchIndexMaintenance,
  reindexWorkspace,
} from "@/modules/search/indexer";
import {
  createTask12Metrics,
  disabledMetricsSink,
} from "@/modules/search/metrics";

import { ResearchFixture } from "../support/research-fixture";

const liveDescribe = process.env.TEST_DATABASE_URL ? describe : describe.skip;

liveDescribe("Task 12 transactional search indexer", () => {
  const maintenance = createSearchIndexMaintenance({
    metrics: createTask12Metrics(disabledMetricsSink),
  });
  let fixture: ResearchFixture;

  beforeAll(async () => {
    fixture = new ResearchFixture({ searchIndexMaintenance: maintenance });
    await fixture.reset();
  });
  afterAll(async () => fixture.close());

  it("derives redacted documents on the caller transaction and rejects stale versions", async () => {
    const actor = await fixture.createActor();
    const created = await fixture.createPerson(actor, {
      displayName: "Ada Indexable",
    });
    const person = created.body?.data?.createPerson?.person;
    expect(person).toBeTruthy();

    const [initial] = await fixture.database
      .select()
      .from(searchDocuments)
      .where(eq(searchDocuments.resourceId, person!.id));
    expect(initial).toMatchObject({
      resourceKind: "person",
      resourceId: person!.id,
      resultKind: "PERSON",
      resultId: person!.id,
      redactedText: "Ada Indexable",
      displayText: "Ada Indexable",
      sourceVersion: 1,
    });

    const updated = await fixture.execute({
      jar: actor.jar,
      query: `mutation($input: UpdatePersonInput!) {
        updatePerson(input: $input) {
          person { id version displayName }
        }
      }`,
      variables: {
        input: {
          id: person!.id,
          expectedVersion: 1,
          displayName: "Ada Updated",
        },
      },
    });
    expect(updated.body?.errors).toBeUndefined();
    await maintenance.apply(fixture.database, [
      {
        action: "upsert",
        sourceId: person!.id,
        sourceKind: "person",
        sourceVersion: 1,
        workspaceId: actor.workspaceId,
      },
    ]);

    const rows = await fixture.database
      .select()
      .from(searchDocuments)
      .where(eq(searchDocuments.resourceId, person!.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      redactedText: "Ada Updated",
      sourceVersion: 2,
    });
  });

  it("reindexes one workspace idempotently with bounded batches", async () => {
    const actor = await fixture.createActor();
    await fixture.createPerson(actor, { displayName: "Reindex One" });
    await fixture.createPerson(actor, { displayName: "Reindex Two" });
    await fixture.database
      .delete(searchDocuments)
      .where(eq(searchDocuments.workspaceId, actor.workspaceId));

    const first = await reindexWorkspace({
      batchSize: 1,
      database: fixture.database,
      dryRun: false,
      maintenance,
      workspaceId: actor.workspaceId,
    });
    const firstDocuments = await fixture.database
      .select({
        resourceId: searchDocuments.resourceId,
        updatedAt: searchDocuments.updatedAt,
      })
      .from(searchDocuments)
      .where(eq(searchDocuments.workspaceId, actor.workspaceId))
      .orderBy(searchDocuments.resourceId);
    const second = await reindexWorkspace({
      batchSize: 1,
      database: fixture.database,
      dryRun: false,
      maintenance,
      workspaceId: actor.workspaceId,
    });
    const secondDocuments = await fixture.database
      .select({
        resourceId: searchDocuments.resourceId,
        updatedAt: searchDocuments.updatedAt,
      })
      .from(searchDocuments)
      .where(eq(searchDocuments.workspaceId, actor.workspaceId))
      .orderBy(searchDocuments.resourceId);
    const [stored] = await fixture.database
      .select({ value: count() })
      .from(searchDocuments)
      .where(eq(searchDocuments.workspaceId, actor.workspaceId));
    expect(first).toMatchObject({ processed: 2, upserted: 2 });
    expect(second).toEqual(first);
    expect(secondDocuments).toEqual(firstDocuments);
    expect(stored?.value).toBe(2);
    const invalid = (await fixture.database.execute(sql`
      SELECT count(*)::int AS count
      FROM ${searchDocuments} AS d
      WHERE d.workspace_id = ${actor.workspaceId}::uuid
        AND NOT (
          (d.result_kind = 'PERSON' AND EXISTS (
            SELECT 1 FROM people p
            WHERE p.workspace_id = d.workspace_id AND p.id = d.result_id
          ))
          OR (d.result_kind = 'FACT' AND EXISTS (
            SELECT 1 FROM facts f
            WHERE f.workspace_id = d.workspace_id AND f.id = d.result_id
          ))
          OR (d.result_kind = 'ADDRESS' AND EXISTS (
            SELECT 1 FROM addresses a
            WHERE a.workspace_id = d.workspace_id AND a.id = d.result_id
          ))
          OR (d.result_kind = 'RELATIONSHIP' AND EXISTS (
            SELECT 1 FROM relationships r
            WHERE r.workspace_id = d.workspace_id AND r.id = d.result_id
          ))
          OR (d.result_kind = 'EVIDENCE' AND (
            EXISTS (
              SELECT 1 FROM evidence_items e
              WHERE e.workspace_id = d.workspace_id AND e.id = d.result_id
            ) OR EXISTS (
              SELECT 1 FROM sources s
              WHERE s.workspace_id = d.workspace_id AND s.id = d.result_id
            )
          ))
        )
    `)) as unknown as Array<{ count: number }>;
    expect(invalid[0]?.count).toBe(0);
  });

  it("indexes only the explicit redacted allowlist", async () => {
    const actor = await fixture.createActor();
    const source = await fixture.createPerson(actor, {
      biography: "BiographyPhone +1 212 555 0101",
      displayName: "Endpoint Source Secret",
      sensitivity: "PUBLIC",
    });
    const target = await fixture.createPerson(actor, {
      displayName: "Endpoint Target Secret",
      sensitivity: "PUBLIC",
    });
    const sourceId = source.body?.data?.createPerson?.person?.id;
    const targetId = target.body?.data?.createPerson?.person?.id;
    if (!sourceId || !targetId) throw new Error("Person fixture failed.");
    const [personDocument] = await fixture.database
      .select()
      .from(searchDocuments)
      .where(eq(searchDocuments.resourceId, sourceId));
    expect(JSON.stringify(personDocument)).not.toContain("BiographyPhone");
    expect(JSON.stringify(personDocument)).not.toContain("555 0101");

    const noteId = newId();
    await fixture.database.insert(notes).values({
      id: noteId,
      workspaceId: actor.workspaceId,
      personId: sourceId,
      plainText: "note-person@example.test +1 212 555 0111",
      sensitivity: "internal",
      createdBy: actor.principalId,
      updatedBy: actor.principalId,
    });
    await maintenance.apply(fixture.database, [
      {
        action: "upsert",
        sourceKind: "note",
        sourceId: noteId,
        sourceVersion: 1,
        workspaceId: actor.workspaceId,
      },
    ]);
    expect(
      await fixture.database
        .select()
        .from(searchDocuments)
        .where(eq(searchDocuments.resourceId, noteId)),
    ).toEqual([]);

    const evidenceSourceId = newId();
    await fixture.database.insert(sources).values({
      id: evidenceSourceId,
      workspaceId: actor.workspaceId,
      kind: "document",
      title: "Safe source title",
      publisher: "publisher-secret@example.test",
      author: "+1 212 555 0199",
      citation: "Employee identifier Case Sensitive 991",
      sensitivity: "public",
      createdBy: actor.principalId,
      updatedBy: actor.principalId,
    });
    await maintenance.apply(fixture.database, [
      {
        action: "upsert",
        sourceKind: "source",
        sourceId: evidenceSourceId,
        sourceVersion: 1,
        workspaceId: actor.workspaceId,
      },
    ]);
    const [sourceDocument] = await fixture.database
      .select()
      .from(searchDocuments)
      .where(eq(searchDocuments.resourceId, evidenceSourceId));
    expect(sourceDocument).toMatchObject({
      bodyText: "",
      displayText: "Safe source title",
      redactedText: "Safe source title",
    });
    expect(JSON.stringify(sourceDocument)).not.toContain("publisher-secret");
    expect(JSON.stringify(sourceDocument)).not.toContain("555 0199");
    expect(JSON.stringify(sourceDocument)).not.toContain("Case Sensitive 991");
    const evidenceItemId = newId();
    await fixture.database.insert(evidenceItems).values({
      id: evidenceItemId,
      workspaceId: actor.workspaceId,
      sourceId: evidenceSourceId,
      checksum: "task12-raw-excerpt",
      sensitivity: "public",
      createdBy: actor.principalId,
      updatedBy: actor.principalId,
    });
    const excerptId = newId();
    await fixture.database.insert(evidenceExcerpts).values({
      id: excerptId,
      workspaceId: actor.workspaceId,
      evidenceItemId,
      excerpt: "raw-excerpt@example.test +1 212 555 0133",
      checksum: "task12-raw-excerpt-content",
      redactionState: "clear",
      createdBy: actor.principalId,
    });
    await maintenance.apply(fixture.database, [
      {
        action: "upsert",
        sourceKind: "evidence_excerpt",
        sourceId: excerptId,
        sourceVersion: 1,
        workspaceId: actor.workspaceId,
      },
    ]);
    expect(
      await fixture.database
        .select()
        .from(searchDocuments)
        .where(eq(searchDocuments.resourceId, excerptId)),
    ).toEqual([]);

    await fixture.database
      .update(sources)
      .set({
        title: "Updated safe source title",
        publisher: "updated-publisher-secret@example.test",
        version: 2,
        updatedAt: new Date(),
      })
      .where(eq(sources.id, evidenceSourceId));
    await maintenance.apply(fixture.database, [
      {
        action: "upsert",
        sourceKind: "source",
        sourceId: evidenceSourceId,
        sourceVersion: 2,
        workspaceId: actor.workspaceId,
      },
    ]);
    const [updatedSourceDocument] = await fixture.database
      .select()
      .from(searchDocuments)
      .where(eq(searchDocuments.resourceId, evidenceSourceId));
    expect(updatedSourceDocument).toMatchObject({
      bodyText: "",
      displayText: "Updated safe source title",
      sourceVersion: 2,
    });
    expect(JSON.stringify(updatedSourceDocument)).not.toContain(
      "updated-publisher-secret",
    );

    const definitionId = newId();
    await fixture.database.insert(factDefinitions).values({
      id: definitionId,
      workspaceId: actor.workspaceId,
      namespace: "contact",
      fieldKey: "phone_number",
      label: "Phone number",
      allowedValueType: "text",
      searchable: true,
      state: "active",
      createdBy: actor.principalId,
      updatedBy: actor.principalId,
    });
    const factId = newId();
    await fixture.database.insert(facts).values({
      id: factId,
      workspaceId: actor.workspaceId,
      personId: sourceId,
      factDefinitionId: definitionId,
      namespace: "contact",
      fieldKey: "phone_number",
      label: "Phone number",
      valueType: "text",
      valueText: "+1 212 555 0122",
      normalizedSearchValue: "+12125550122",
      sensitivity: "public",
      createdBy: actor.principalId,
      updatedBy: actor.principalId,
    });
    await maintenance.apply(fixture.database, [
      {
        action: "upsert",
        sourceKind: "fact",
        sourceId: factId,
        sourceVersion: 1,
        workspaceId: actor.workspaceId,
      },
    ]);
    const [protectedValueDocument] = await fixture.database
      .select()
      .from(searchDocuments)
      .where(eq(searchDocuments.resourceId, factId));
    expect(protectedValueDocument).toMatchObject({
      bodyText: "",
      displayText: "Phone number",
      redactedText: "Phone number",
    });
    expect(JSON.stringify(protectedValueDocument)).not.toContain("555 0122");
    expect(JSON.stringify(protectedValueDocument)).not.toContain(
      "+12125550122",
    );

    await maintenance.apply(fixture.database, [
      {
        action: "remove",
        sourceKind: "source",
        sourceId: evidenceSourceId,
        sourceVersion: 2,
        workspaceId: actor.workspaceId,
      },
    ]);
    expect(
      await fixture.database
        .select()
        .from(searchDocuments)
        .where(eq(searchDocuments.resourceId, evidenceSourceId)),
    ).toEqual([]);

    const typeId = newId();
    await fixture.database.insert(relationshipTypes).values({
      id: typeId,
      workspaceId: actor.workspaceId,
      key: `colleague-${newId()}`,
      forwardLabel: "Colleague",
      inverseLabel: "Colleague of",
      createdBy: actor.principalId,
      updatedBy: actor.principalId,
    });
    const relationshipId = newId();
    await fixture.database.insert(relationships).values({
      id: relationshipId,
      workspaceId: actor.workspaceId,
      sourcePersonId: sourceId,
      targetPersonId: targetId,
      relationshipTypeId: typeId,
      sensitivity: "public",
      createdBy: actor.principalId,
      updatedBy: actor.principalId,
    });
    await maintenance.apply(fixture.database, [
      {
        action: "upsert",
        sourceKind: "relationship",
        sourceId: relationshipId,
        sourceVersion: 1,
        workspaceId: actor.workspaceId,
      },
    ]);
    const [relationshipDocument] = await fixture.database
      .select()
      .from(searchDocuments)
      .where(eq(searchDocuments.resourceId, relationshipId));
    expect(relationshipDocument?.displayText).toBe("Colleague");
    expect(JSON.stringify(relationshipDocument)).not.toContain(
      "Endpoint Source Secret",
    );
    expect(JSON.stringify(relationshipDocument)).not.toContain(
      "Endpoint Target Secret",
    );
  });

  it("uses canonical fact sources for more than 64 facts and refreshes definition changes without fan-out", async () => {
    const actor = await fixture.createActor();
    const created = await fixture.createPerson(actor, {
      displayName: "Bulk Fact Subject",
      sensitivity: "PUBLIC",
    });
    const personId = created.body?.data?.createPerson?.person?.id;
    if (!personId) throw new Error("Person fixture failed.");
    const definitionId = newId();
    await fixture.database.insert(factDefinitions).values({
      id: definitionId,
      workspaceId: actor.workspaceId,
      namespace: "profile",
      fieldKey: "innocuous_note",
      label: "BulkDefinitionLabel",
      allowedValueType: "text",
      searchable: true,
      state: "active",
      createdBy: actor.principalId,
      updatedBy: actor.principalId,
    });
    const disguisedValues = [
      "disguised-person@example.test",
      "+1 (212) 555-0177",
      "Case Sensitive Employee Identifier 88",
    ];
    const factRows = Array.from({ length: 65 }, (_, index) => ({
      id: newId(),
      workspaceId: actor.workspaceId,
      personId,
      factDefinitionId: definitionId,
      namespace: "profile",
      fieldKey: "innocuous_note",
      label: "BulkDefinitionLabel",
      valueType: "text" as const,
      valueText: disguisedValues[index] ?? `free-form-secret-${index}`,
      normalizedSearchValue:
        disguisedValues[index] ?? `free-form-secret-${index}`,
      sensitivity: "public" as const,
      createdBy: actor.principalId,
      updatedBy: actor.principalId,
    }));
    await fixture.database.insert(facts).values(factRows);

    await maintenance.apply(fixture.database, [
      {
        action: "upsert",
        sourceKind: "fact_definition",
        sourceId: definitionId,
        sourceVersion: 1,
        workspaceId: actor.workspaceId,
      },
    ]);
    expect(
      await fixture.database
        .select()
        .from(searchDocuments)
        .where(eq(searchDocuments.resourceKind, "fact_definition")),
    ).toEqual([]);

    await reindexWorkspace({
      batchSize: 17,
      database: fixture.database,
      dryRun: false,
      maintenance,
      workspaceId: actor.workspaceId,
    });
    const indexed = await fixture.database
      .select()
      .from(searchDocuments)
      .where(
        and(
          eq(searchDocuments.workspaceId, actor.workspaceId),
          eq(searchDocuments.resourceKind, "fact"),
        ),
      );
    expect(indexed).toHaveLength(65);
    expect(new Set(indexed.map(({ resourceId }) => resourceId))).toEqual(
      new Set(factRows.map(({ id }) => id)),
    );
    expect(indexed.every(({ bodyText }) => bodyText === "")).toBe(true);
    const serialized = JSON.stringify(indexed);
    for (const secret of disguisedValues)
      expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain("free-form-secret");

    const search = async (query: string) =>
      fixture.execute<{
        search: { nodes: Array<{ id: string }> };
      }>({
        jar: actor.jar,
        query: `query Search($input: SearchInput!) {
          search(input: $input) { nodes { id } }
        }`,
        variables: {
          input: {
            version: 1,
            match: { type: "TEXT", query },
            kinds: ["FACT"],
            filters: {},
            first: 100,
          },
        },
      });
    expect(
      (await search("BulkDefinitionLabel")).body?.data?.search.nodes,
    ).toHaveLength(65);

    const definitionChangedAt = new Date(Date.now() + 1_000);
    await fixture.database
      .update(factDefinitions)
      .set({
        label: "RefreshedDefinitionLabel",
        updatedAt: definitionChangedAt,
        version: 2,
      })
      .where(eq(factDefinitions.id, definitionId));
    await maintenance.apply(fixture.database, [
      {
        action: "upsert",
        sourceKind: "fact_definition",
        sourceId: definitionId,
        sourceVersion: 2,
        workspaceId: actor.workspaceId,
      },
    ]);
    expect(
      (await search("BulkDefinitionLabel")).body?.data?.search.nodes,
    ).toEqual([]);

    expect(
      (await search("RefreshedDefinitionLabel")).body?.data?.search.nodes,
    ).toHaveLength(65);
    const refreshed = await fixture.database
      .select()
      .from(searchDocuments)
      .where(
        and(
          eq(searchDocuments.workspaceId, actor.workspaceId),
          eq(searchDocuments.resourceKind, "fact"),
        ),
      );
    expect(refreshed).toHaveLength(65);
    expect(
      refreshed.every(
        ({ displayText, updatedAt }) =>
          displayText === "RefreshedDefinitionLabel" &&
          updatedAt.getTime() === definitionChangedAt.getTime(),
      ),
    ).toBe(true);
  });

  it("transactionally refreshes more than 64 canonical relationship documents after a type change", async () => {
    const actor = await fixture.createActor();
    const source = await fixture.createPerson(actor, {
      displayName: "Bulk relationship source",
    });
    const target = await fixture.createPerson(actor, {
      displayName: "Bulk relationship target",
    });
    const sourceId = source.body?.data?.createPerson?.person?.id;
    const targetId = target.body?.data?.createPerson?.person?.id;
    if (!sourceId || !targetId) throw new Error("Person fixture failed.");
    const typeId = newId();
    await fixture.database.insert(relationshipTypes).values({
      id: typeId,
      workspaceId: actor.workspaceId,
      key: `bulk-${newId()}`,
      forwardLabel: "OriginalBulkRelationship",
      inverseLabel: "Original bulk relationship of",
      createdBy: actor.principalId,
      updatedBy: actor.principalId,
    });
    const rows = Array.from({ length: 65 }, () => ({
      id: newId(),
      workspaceId: actor.workspaceId,
      sourcePersonId: sourceId,
      targetPersonId: targetId,
      relationshipTypeId: typeId,
      sensitivity: "public" as const,
      createdBy: actor.principalId,
      updatedBy: actor.principalId,
    }));
    await fixture.database.insert(relationships).values(rows);
    await maintenance.apply(fixture.database, [
      {
        action: "upsert",
        sourceKind: "relationship_type",
        sourceId: typeId,
        sourceVersion: 1,
        workspaceId: actor.workspaceId,
      },
    ]);
    expect(
      await fixture.database
        .select()
        .from(searchDocuments)
        .where(
          and(
            eq(searchDocuments.workspaceId, actor.workspaceId),
            eq(searchDocuments.resourceKind, "relationship"),
          ),
        ),
    ).toHaveLength(65);
    const changedAt = new Date(Date.now() + 1_000);
    await fixture.database
      .update(relationshipTypes)
      .set({
        forwardLabel: "RefreshedBulkRelationship",
        version: 2,
        updatedAt: changedAt,
      })
      .where(eq(relationshipTypes.id, typeId));
    await maintenance.apply(fixture.database, [
      {
        action: "upsert",
        sourceKind: "relationship_type",
        sourceId: typeId,
        sourceVersion: 2,
        workspaceId: actor.workspaceId,
      },
    ]);
    const refreshed = await fixture.database
      .select()
      .from(searchDocuments)
      .where(
        and(
          eq(searchDocuments.workspaceId, actor.workspaceId),
          eq(searchDocuments.resourceKind, "relationship"),
        ),
      );
    expect(refreshed).toHaveLength(65);
    expect(
      refreshed.every(
        (row) =>
          row.displayText === "RefreshedBulkRelationship" &&
          row.updatedAt.getTime() === changedAt.getTime(),
      ),
    ).toBe(true);
  });

  it("indexes only the closed typed fact-value classes", async () => {
    const actor = await fixture.createActor();
    const created = await fixture.createPerson(actor, {
      displayName: "Typed Fact Subject",
      sensitivity: "PUBLIC",
    });
    const personId = created.body?.data?.createPerson?.person?.id;
    if (!personId) throw new Error("Person fixture failed.");
    const typed = [
      {
        type: "boolean" as const,
        value: { valueBoolean: true },
        expected: "true",
      },
      {
        type: "date" as const,
        value: { valueDateStart: "2026-08-03" },
        expected: "2026-08-03",
      },
      {
        type: "date_range" as const,
        value: { valueDateStart: "2026-08-01", valueDateEnd: "2026-08-03" },
        expected: "2026-08-01 2026-08-03",
      },
      {
        type: "timestamp" as const,
        value: { valueTimestamp: new Date("2026-08-03T12:34:56.000Z") },
        expected: "2026-08-03T12:34:56.000Z",
      },
      {
        type: "duration" as const,
        value: { valueDecimal: "15", unit: "unit-secret@example.test" },
        expected: "15.000000000000",
      },
      {
        type: "quantity" as const,
        value: { valueDecimal: "42.5", unit: "+1 212 555 0166" },
        expected: "42.500000000000",
      },
      {
        type: "integer" as const,
        value: { valueDecimal: "123456789" },
        expected: "",
      },
      {
        type: "decimal" as const,
        value: { valueDecimal: "987654321.123" },
        expected: "",
      },
    ];
    const mutations = [];
    for (const [index, item] of typed.entries()) {
      const definitionId = newId();
      const factId = newId();
      await fixture.database.insert(factDefinitions).values({
        id: definitionId,
        workspaceId: actor.workspaceId,
        namespace: "typed",
        fieldKey: `value_${index}`,
        label: `Typed ${item.type}`,
        allowedValueType: item.type,
        searchable: true,
        state: "active",
        createdBy: actor.principalId,
        updatedBy: actor.principalId,
      });
      await fixture.database.insert(facts).values({
        id: factId,
        workspaceId: actor.workspaceId,
        personId,
        factDefinitionId: definitionId,
        namespace: "typed",
        fieldKey: `value_${index}`,
        label: `Typed ${item.type}`,
        valueType: item.type,
        ...item.value,
        sensitivity: "public",
        createdBy: actor.principalId,
        updatedBy: actor.principalId,
      });
      mutations.push({
        action: "upsert" as const,
        sourceKind: "fact" as const,
        sourceId: factId,
        sourceVersion: 1,
        workspaceId: actor.workspaceId,
      });
    }
    await maintenance.apply(fixture.database, mutations);
    const documents = await fixture.database
      .select()
      .from(searchDocuments)
      .where(
        and(
          eq(searchDocuments.workspaceId, actor.workspaceId),
          eq(searchDocuments.resourceKind, "fact"),
        ),
      );
    expect(documents).toHaveLength(typed.length);
    const byLabel = new Map(
      documents.map(({ bodyText, redactedText }) => [redactedText, bodyText]),
    );
    for (const item of typed)
      expect(byLabel.get(`Typed ${item.type}`)).toBe(item.expected);
    const serialized = JSON.stringify(documents);
    expect(serialized).not.toContain("unit-secret@example.test");
    expect(serialized).not.toContain("555 0166");
    expect(serialized).not.toContain("123456789");
    expect(serialized).not.toContain("987654321.123");
  });

  it("indexes only final accepted clear evidence text and never extracted content", async () => {
    const actor = await fixture.createActor();
    const sourceId = newId();
    const evidenceItemId = newId();
    const excerptId = newId();
    const noteId = newId();
    await fixture.database.insert(sources).values({
      id: sourceId,
      workspaceId: actor.workspaceId,
      kind: "interview",
      title: "Jose Evidence Source",
      sensitivity: "public",
      createdBy: actor.principalId,
      updatedBy: actor.principalId,
    });
    await fixture.database.insert(evidenceItems).values({
      id: evidenceItemId,
      workspaceId: actor.workspaceId,
      sourceId,
      checksum: "sha256:" + "a".repeat(64),
      reviewState: "accepted",
      extractedText: "EXTRACTED_NEVER_INDEX",
      sensitivity: "public",
      createdBy: actor.principalId,
      updatedBy: actor.principalId,
    });
    await fixture.database.insert(evidenceExcerpts).values({
      id: excerptId,
      workspaceId: actor.workspaceId,
      evidenceItemId,
      excerpt: "ClearExcerptNeedle",
      checksum: "sha256:" + "b".repeat(64),
      redactionState: "clear",
      createdBy: actor.principalId,
    });
    await fixture.database.insert(notes).values({
      id: noteId,
      workspaceId: actor.workspaceId,
      evidenceItemId,
      plainText: "FinalNoteNeedle",
      sensitivity: "public",
      createdBy: actor.principalId,
      updatedBy: actor.principalId,
    });
    await maintenance.apply(fixture.database, [
      {
        action: "upsert",
        sourceKind: "evidence_item",
        sourceId: evidenceItemId,
        sourceVersion: 1,
        workspaceId: actor.workspaceId,
      },
    ]);
    const documents = await fixture.database
      .select()
      .from(searchDocuments)
      .where(
        and(
          eq(searchDocuments.workspaceId, actor.workspaceId),
          eq(searchDocuments.resultId, evidenceItemId),
        ),
      );
    expect(new Set(documents.map((row) => row.resourceKind))).toEqual(
      new Set(["evidence_item", "evidence_excerpt", "note"]),
    );
    const serialized = JSON.stringify(documents);
    expect(serialized).toContain("ClearExcerptNeedle");
    expect(serialized).toContain("FinalNoteNeedle");
    expect(serialized).not.toContain("EXTRACTED_NEVER_INDEX");

    const blockedExcerptId = newId();
    await fixture.database.insert(evidenceExcerpts).values({
      id: blockedExcerptId,
      workspaceId: actor.workspaceId,
      evidenceItemId,
      excerpt: "REDACTED_NEVER_INDEX",
      checksum: "sha256:" + "c".repeat(64),
      redactionState: "redacted",
      createdBy: actor.principalId,
    });
    await maintenance.apply(fixture.database, [
      {
        action: "upsert",
        sourceKind: "evidence_excerpt",
        sourceId: blockedExcerptId,
        sourceVersion: 1,
        workspaceId: actor.workspaceId,
      },
    ]);
    expect(
      JSON.stringify(await fixture.database.select().from(searchDocuments)),
    ).not.toContain("REDACTED_NEVER_INDEX");
  });

  it("indexes only approved address locality fields for live person associations", async () => {
    const actor = await fixture.createActor();
    const created = await fixture.createPerson(actor, {
      displayName: "Address Subject",
      sensitivity: "PUBLIC",
    });
    const personId = created.body?.data?.createPerson?.person?.id;
    if (!personId) throw new Error("Person fixture failed.");
    const addressId = newId();
    const personAddressId = newId();
    await fixture.database.insert(addresses).values({
      id: addressId,
      workspaceId: actor.workspaceId,
      line1: "4417 Never Index Street",
      line2: "Never Index Suite",
      locality: "Approved Locality",
      region: "Safe Region",
      postalCode: "02139",
      countryCode: "US",
      unstructuredText: "Do not index this address narrative",
      normalizedHash: "a4".repeat(32),
      latitude: "42.362000",
      longitude: "-71.084000",
      sensitivity: "public",
      createdBy: actor.principalId,
      updatedBy: actor.principalId,
    });
    await fixture.database.insert(personAddresses).values({
      id: personAddressId,
      workspaceId: actor.workspaceId,
      personId,
      addressId,
      addressKind: "home",
      createdBy: actor.principalId,
      updatedBy: actor.principalId,
    });

    await maintenance.apply(fixture.database, [
      {
        action: "upsert",
        sourceKind: "person_address",
        sourceId: personAddressId,
        sourceVersion: 1,
        workspaceId: actor.workspaceId,
      },
    ]);

    const initial = await fixture.database
      .select()
      .from(searchDocuments)
      .where(eq(searchDocuments.resultId, addressId));
    expect(initial).toEqual([
      expect.objectContaining({
        resourceKind: "person_address",
        resourceId: personAddressId,
        resultKind: "ADDRESS",
        resultId: addressId,
        subjectPersonId: personId,
        sourceVersion: 1,
        displayText: "Approved Locality, Safe Region, 02139, US",
      }),
    ]);
    const serialized = JSON.stringify(initial);
    expect(serialized).not.toContain("Never Index Street");
    expect(serialized).not.toContain("Never Index Suite");
    expect(serialized).not.toContain("address narrative");
    expect(serialized).not.toContain("normalized-address-hash");
    expect(serialized).not.toContain("42.362");
    expect(serialized).not.toContain("71.084");

    await fixture.database
      .update(addresses)
      .set({
        locality: "Updated Locality",
        version: 2,
        updatedAt: new Date(),
      })
      .where(eq(addresses.id, addressId));
    await maintenance.apply(fixture.database, [
      {
        action: "upsert",
        sourceKind: "person_address",
        sourceId: personAddressId,
        sourceVersion: 1,
        workspaceId: actor.workspaceId,
      },
    ]);
    const [updated] = await fixture.database
      .select()
      .from(searchDocuments)
      .where(eq(searchDocuments.resourceId, personAddressId));
    expect(updated).toMatchObject({
      displayText: "Updated Locality, Safe Region, 02139, US",
      sourceVersion: 1,
    });

    await fixture.database
      .delete(searchDocuments)
      .where(eq(searchDocuments.workspaceId, actor.workspaceId));
    await reindexWorkspace({
      batchSize: 1,
      database: fixture.database,
      dryRun: false,
      maintenance,
      workspaceId: actor.workspaceId,
    });
    expect(
      await fixture.database
        .select()
        .from(searchDocuments)
        .where(eq(searchDocuments.resourceId, personAddressId)),
    ).toHaveLength(1);

    await maintenance.apply(fixture.database, [
      {
        action: "remove",
        sourceKind: "person_address",
        sourceId: personAddressId,
        sourceVersion: 1,
        workspaceId: actor.workspaceId,
      },
    ]);
    expect(
      await fixture.database
        .select()
        .from(searchDocuments)
        .where(eq(searchDocuments.resultId, addressId)),
    ).toEqual([]);
  });
});
