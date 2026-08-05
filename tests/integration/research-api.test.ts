// @vitest-environment node

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";

import { newId } from "@/db/id";
import { factDefinitions, factRevisions, facts } from "@/db/schema/facts";
import { files } from "@/db/schema/files";
import {
  CreateFactDefinitionDocument,
  CreateFactDocument,
  MergePersonDocument,
  PersonHeaderDocument,
  PersonFilesDocument,
} from "@/graphql/generated/graphql";
import {
  evidenceItems,
  factEvidence,
  notes,
  sources,
  tags,
} from "@/db/schema/evidence";
import { auditEvents } from "@/db/schema/operations";
import { people, personNames } from "@/db/schema/people";
import { relationshipTypes, relationships } from "@/db/schema/relationships";
import { accessPolicies, resourceGrants } from "@/db/schema/workspaces";

import { expectGraphQLError } from "../support/graphql";
import { PEOPLE_QUERY, ResearchFixture } from "../support/research-fixture";

const liveDescribe = process.env.TEST_DATABASE_URL ? describe : describe.skip;

function required<T>(value: T | null | undefined): T {
  if (value == null) throw new Error("Required fixture value is missing");
  return value;
}

liveDescribe("research API", () => {
  let fixture: ResearchFixture;

  beforeAll(() => {
    fixture = new ResearchFixture();
  });
  beforeEach(async () => fixture.reset());
  afterAll(async () => fixture.close());

  it("creates a UUIDv7 person through the real authenticated handler", async () => {
    const owner = await fixture.createActor();
    const result = await fixture.createPerson(owner, {
      biography: "Evidence-backed profile",
      displayName: "Ada Lovelace",
      sensitivity: "INTERNAL",
      sortName: "Lovelace, Ada",
    });

    expect(result.body?.errors).toBeUndefined();
    expect(result.body?.data?.createPerson).toMatchObject({
      code: null,
      issues: [],
      person: {
        displayName: "Ada Lovelace",
        sensitivity: "INTERNAL",
        sortName: "Lovelace, Ada",
        status: "ACTIVE",
        version: 1,
      },
    });
    expect(result.body?.data?.createPerson?.person?.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu,
    );
  });

  it("HUM-FR-008 selects and clears presentation pointers with full contract guards", async () => {
    const owner = await fixture.createActor();
    const foreignOwner = await fixture.createActor();
    const subject = await fixture.createPerson(owner, {
      displayName: "Presentation subject",
    });
    const other = await fixture.createPerson(owner, {
      displayName: "Other presentation subject",
    });
    const foreign = await fixture.createPerson(foreignOwner, {
      displayName: "Foreign presentation subject",
    });
    const subjectId = required(subject.body?.data?.createPerson?.person?.id);
    const otherId = required(other.body?.data?.createPerson?.person?.id);
    const foreignId = required(foreign.body?.data?.createPerson?.person?.id);

    const subjectNameId = newId();
    const otherNameId = newId();
    const foreignNameId = newId();
    await fixture.database.insert(personNames).values([
      {
        id: subjectNameId,
        workspaceId: owner.workspaceId,
        personId: subjectId,
        kind: "preferred",
        fullName: "Presentation Subject Preferred",
        sensitivity: "internal",
        state: "verified",
        createdBy: owner.principalId,
        updatedBy: owner.principalId,
      },
      {
        id: otherNameId,
        workspaceId: owner.workspaceId,
        personId: otherId,
        kind: "preferred",
        fullName: "Other Preferred",
        sensitivity: "internal",
        state: "verified",
        createdBy: owner.principalId,
        updatedBy: owner.principalId,
      },
      {
        id: foreignNameId,
        workspaceId: foreignOwner.workspaceId,
        personId: foreignId,
        kind: "preferred",
        fullName: "Foreign Preferred",
        sensitivity: "internal",
        state: "verified",
        createdBy: foreignOwner.principalId,
        updatedBy: foreignOwner.principalId,
      },
    ]);

    const checksum = `sha256:${"b".repeat(64)}`;
    const makeFile = (input: {
      id: string;
      workspaceId: string;
      userId: string;
      quarantineState: string;
      scanState: string;
    }) => ({
      id: input.id,
      workspaceId: input.workspaceId,
      storageProvider: "minio",
      storageBucket: "humans-private",
      storageKey: `presentation/${input.id}.jpg`,
      originalName: `${input.id}.jpg`,
      mediaType: "image/jpeg",
      byteSize: 128,
      checksum,
      quarantineState: input.quarantineState,
      scanState: input.scanState,
      ocrState: "not_requested",
      extractionState: "not_requested",
      sensitivity: "internal" as const,
      uploadedBy: input.userId,
      createdBy: input.userId,
      updatedBy: input.userId,
    });
    const availableFileId = newId();
    const quarantinedFileId = newId();
    const foreignFileId = newId();
    await fixture.database.insert(files).values([
      makeFile({
        id: availableFileId,
        workspaceId: owner.workspaceId,
        userId: owner.userId,
        quarantineState: "available",
        scanState: "clean",
      }),
      makeFile({
        id: quarantinedFileId,
        workspaceId: owner.workspaceId,
        userId: owner.userId,
        quarantineState: "quarantined",
        scanState: "pending",
      }),
      makeFile({
        id: foreignFileId,
        workspaceId: foreignOwner.workspaceId,
        userId: foreignOwner.userId,
        quarantineState: "available",
        scanState: "clean",
      }),
    ]);

    const SELECT_PRESENTATION = /* GraphQL */ `
      mutation ($input: SelectPersonPresentationInput!) {
        selectPersonPresentation(input: $input) {
          code
          currentVersion
          person {
            id
            primaryNameId
            primaryPhotoFileId
            mergedIntoPersonId
            version
          }
          issues {
            code
            path
          }
        }
      }
    `;
    type PresentationResult = {
      selectPersonPresentation: {
        code: string | null;
        currentVersion: number | null;
        person: {
          id: string;
          primaryNameId: string | null;
          primaryPhotoFileId: string | null;
          mergedIntoPersonId: string | null;
          version: number;
        } | null;
        issues: Array<{ code: string; path: string[] }>;
      };
    };
    const select = (input: Record<string, unknown>) =>
      fixture.execute<PresentationResult>({
        jar: owner.jar,
        query: SELECT_PRESENTATION,
        variables: { input },
      });

    const applied = await select({
      personId: subjectId,
      expectedVersion: 1,
      primaryNameId: subjectNameId,
      primaryPhotoFileId: availableFileId,
    });
    expect(applied.body?.errors).toBeUndefined();
    expect(applied.body?.data?.selectPersonPresentation).toMatchObject({
      person: {
        id: subjectId,
        primaryNameId: subjectNameId,
        primaryPhotoFileId: availableFileId,
        mergedIntoPersonId: null,
        version: 2,
      },
      issues: [],
    });

    const attachedFiles = await fixture.execute<{
      person: {
        files: {
          nodes: Array<{
            id: string;
            originalName: string;
            availability: string;
            scanState: string;
            roles: string[];
          }>;
          pageInfo: { hasNextPage: boolean; endCursor: string | null };
        };
      } | null;
    }>({
      jar: owner.jar,
      query: PersonFilesDocument,
      operationName: "PersonFiles",
      variables: { first: 10, id: subjectId },
    });
    expect(attachedFiles.body?.errors).toBeUndefined();
    expect(attachedFiles.body?.data?.person?.files).toMatchObject({
      nodes: [
        {
          id: availableFileId,
          availability: "AVAILABLE",
          scanState: "CLEAN",
          roles: ["PRIMARY_PHOTO"],
        },
      ],
      pageInfo: { hasNextPage: false },
    });
    expect(JSON.stringify(attachedFiles.body)).not.toContain("storageKey");
    expect(JSON.stringify(attachedFiles.body)).not.toContain("checksum");

    const restrictedFileId = newId();
    await fixture.database.insert(files).values(
      makeFile({
        id: restrictedFileId,
        workspaceId: owner.workspaceId,
        userId: owner.userId,
        quarantineState: "available",
        scanState: "clean",
      }),
    );
    const definition = await fixture.execute<{
      createFactDefinition: { factDefinition: { id: string } | null };
    }>({
      jar: owner.jar,
      query: CreateFactDefinitionDocument,
      operationName: "CreateFactDefinition",
      variables: {
        input: {
          allowedValueType: "FILE_REFERENCE",
          fieldKey: "restricted_file_fact",
          label: "Restricted file fact",
          namespace: "person",
        },
      },
    });
    const definitionId = required(
      definition.body?.data?.createFactDefinition.factDefinition?.id,
    );
    const createdFact = await fixture.execute<{
      createFact: { fact: { id: string } | null };
    }>({
      jar: owner.jar,
      query: CreateFactDocument,
      operationName: "CreateFact",
      variables: {
        input: {
          definitionId,
          personId: subjectId,
          sensitivity: "RESTRICTED",
          value: { fileId: restrictedFileId },
        },
      },
    });
    expect(createdFact.body?.data?.createFact.fact?.id).toBeTruthy();
    const restrictedFiles = await fixture.execute<{
      person: { files: { nodes: Array<{ id: string }> } } | null;
    }>({
      jar: owner.jar,
      query: PersonFilesDocument,
      operationName: "PersonFiles",
      variables: { first: 10, id: subjectId },
    });
    expect(restrictedFiles.body?.errors).toBeUndefined();
    expect(restrictedFiles.body?.data?.person?.files.nodes).toEqual([
      expect.objectContaining({ id: availableFileId }),
    ]);

    const sourceOnlyFileId = newId();
    await fixture.database.insert(files).values(
      makeFile({
        id: sourceOnlyFileId,
        workspaceId: owner.workspaceId,
        userId: owner.userId,
        quarantineState: "available",
        scanState: "clean",
      }),
    );
    const sourceOnlyDefinition = await fixture.execute<{
      createFactDefinition: { factDefinition: { id: string } | null };
    }>({
      jar: owner.jar,
      query: CreateFactDefinitionDocument,
      operationName: "CreateFactDefinition",
      variables: {
        input: {
          allowedValueType: "TEXT",
          fieldKey: "source_only_fact",
          label: "Source-only fact",
          namespace: "person",
        },
      },
    });
    const sourceOnlyDefinitionId = required(
      sourceOnlyDefinition.body?.data?.createFactDefinition.factDefinition?.id,
    );
    const sourceOnlyFact = await fixture.execute<{
      createFact: { fact: { id: string } | null };
    }>({
      jar: owner.jar,
      query: CreateFactDocument,
      operationName: "CreateFact",
      variables: {
        input: {
          definitionId: sourceOnlyDefinitionId,
          personId: subjectId,
          value: { text: "Evidence source policy" },
        },
      },
    });
    const sourceOnlyFactId = required(
      sourceOnlyFact.body?.data?.createFact.fact?.id,
    );
    const restrictedSourceId = newId();
    const sourceOnlyEvidenceId = newId();
    await fixture.database.insert(sources).values({
      id: restrictedSourceId,
      workspaceId: owner.workspaceId,
      kind: "archive",
      title: "Restricted evidence source",
      sensitivity: "restricted",
      createdBy: owner.principalId,
      updatedBy: owner.principalId,
    });
    await fixture.database.insert(evidenceItems).values({
      id: sourceOnlyEvidenceId,
      workspaceId: owner.workspaceId,
      sourceId: restrictedSourceId,
      fileId: sourceOnlyFileId,
      checksum: `sha256:${"d".repeat(64)}`,
      sensitivity: "internal",
      createdBy: owner.principalId,
      updatedBy: owner.principalId,
    });
    await fixture.database.insert(factEvidence).values({
      id: newId(),
      workspaceId: owner.workspaceId,
      factId: sourceOnlyFactId,
      evidenceItemId: sourceOnlyEvidenceId,
      createdBy: owner.principalId,
    });
    const sourceDeniedFiles = await fixture.execute<{
      person: { files: { nodes: Array<{ id: string }> } } | null;
    }>({
      jar: owner.jar,
      query: PersonFilesDocument,
      operationName: "PersonFiles",
      variables: { first: 10, id: subjectId },
    });
    expect(sourceDeniedFiles.body?.errors).toBeUndefined();
    expect(
      sourceDeniedFiles.body?.data?.person?.files.nodes.map((node) => node.id),
    ).not.toContain(sourceOnlyFileId);

    const pagedFileId = newId();
    await fixture.database.insert(files).values(
      makeFile({
        id: pagedFileId,
        workspaceId: owner.workspaceId,
        userId: owner.userId,
        quarantineState: "available",
        scanState: "clean",
      }),
    );
    const pagedDefinition = await fixture.execute<{
      createFactDefinition: { factDefinition: { id: string } | null };
    }>({
      jar: owner.jar,
      query: CreateFactDefinitionDocument,
      operationName: "CreateFactDefinition",
      variables: {
        input: {
          allowedValueType: "FILE_REFERENCE",
          fieldKey: "paged_file_fact",
          label: "Paged file fact",
          namespace: "person",
        },
      },
    });
    const pagedDefinitionId = required(
      pagedDefinition.body?.data?.createFactDefinition.factDefinition?.id,
    );
    const pagedFact = await fixture.execute({
      jar: owner.jar,
      query: CreateFactDocument,
      operationName: "CreateFact",
      variables: {
        input: {
          definitionId: pagedDefinitionId,
          personId: subjectId,
          value: { fileId: pagedFileId },
        },
      },
    });
    expect(pagedFact.body?.errors).toBeUndefined();
    const firstFilePage = await fixture.execute<{
      person: {
        files: {
          nodes: Array<{ id: string }>;
          pageInfo: { hasNextPage: boolean; endCursor: string | null };
        };
      } | null;
    }>({
      jar: owner.jar,
      query: PersonFilesDocument,
      operationName: "PersonFiles",
      variables: { first: 1, id: subjectId },
    });
    const firstPageInfo = firstFilePage.body?.data?.person?.files.pageInfo;
    expect(firstPageInfo?.hasNextPage).toBe(true);
    expect(firstPageInfo?.endCursor).toEqual(expect.any(String));
    const secondFilePage = await fixture.execute<{
      person: { files: { nodes: Array<{ id: string }> } } | null;
    }>({
      jar: owner.jar,
      query: PersonFilesDocument,
      operationName: "PersonFiles",
      variables: {
        first: 1,
        after: firstPageInfo?.endCursor,
        id: subjectId,
      },
    });
    expect(secondFilePage.body?.errors).toBeUndefined();
    expect(secondFilePage.body?.data?.person?.files.nodes).toHaveLength(1);
    expect(
      new Set([
        firstFilePage.body?.data?.person?.files.nodes[0]?.id,
        secondFilePage.body?.data?.person?.files.nodes[0]?.id,
      ]),
    ).toEqual(new Set([availableFileId, pagedFileId]));

    const header = await fixture.execute<{
      person: {
        id: string;
        primaryNameId: string | null;
        primaryPhotoFileId: string | null;
        mergedIntoPersonId: string | null;
        version: number;
      } | null;
    }>({
      jar: owner.jar,
      query: PersonHeaderDocument,
      variables: { id: subjectId },
    });
    expect(header.body?.data?.person).toMatchObject({
      id: subjectId,
      primaryNameId: subjectNameId,
      primaryPhotoFileId: availableFileId,
      mergedIntoPersonId: null,
      version: 2,
    });

    const crossPersonName = await select({
      personId: subjectId,
      expectedVersion: 2,
      primaryNameId: otherNameId,
    });
    expectGraphQLError(crossPersonName, "VALIDATION_FAILED");
    const foreignName = await select({
      personId: subjectId,
      expectedVersion: 2,
      primaryNameId: foreignNameId,
    });
    expectGraphQLError(foreignName, "VALIDATION_FAILED");
    const foreignPhoto = await select({
      personId: subjectId,
      expectedVersion: 2,
      primaryPhotoFileId: foreignFileId,
    });
    expectGraphQLError(foreignPhoto, "VALIDATION_FAILED");
    const unavailablePhoto = await select({
      personId: subjectId,
      expectedVersion: 2,
      primaryPhotoFileId: quarantinedFileId,
    });
    expectGraphQLError(unavailablePhoto, "VALIDATION_FAILED");

    const stale = await select({
      personId: subjectId,
      expectedVersion: 1,
      primaryNameId: subjectNameId,
    });
    expect(stale.body?.data?.selectPersonPresentation).toMatchObject({
      code: "CONFLICT",
      currentVersion: null,
      person: null,
    });

    const cleared = await select({
      personId: subjectId,
      expectedVersion: 2,
      primaryNameId: null,
      primaryPhotoFileId: null,
    });
    expect(cleared.body?.errors).toBeUndefined();
    expect(cleared.body?.data?.selectPersonPresentation).toMatchObject({
      person: {
        id: subjectId,
        primaryNameId: null,
        primaryPhotoFileId: null,
        version: 3,
      },
      issues: [],
    });
    const clearedFiles = await fixture.execute<{
      person: { files: { nodes: Array<{ id: string }> } } | null;
    }>({
      jar: owner.jar,
      query: PersonFilesDocument,
      operationName: "PersonFiles",
      variables: { first: 10, id: subjectId },
    });
    expect(clearedFiles.body?.errors).toBeUndefined();
    expect(clearedFiles.body?.data?.person?.files.nodes).toEqual([
      expect.objectContaining({ id: pagedFileId }),
    ]);

    const merged = await fixture.execute({
      jar: owner.jar,
      query: MergePersonDocument,
      variables: {
        input: {
          winnerPersonId: subjectId,
          loserPersonId: otherId,
          reason: "Full-contract presentation acceptance merge.",
        },
      },
    });
    expect(merged.body?.errors).toBeUndefined();
    expect(merged.body?.data?.mergePerson).toMatchObject({
      person: { id: subjectId, status: "ACTIVE" },
      issues: [],
    });

    const mergedHeader = await fixture.execute<{
      person: {
        id: string;
        status: string;
        mergedIntoPersonId: string | null;
      } | null;
    }>({
      jar: owner.jar,
      query: PersonHeaderDocument,
      variables: { id: otherId },
    });
    expect(mergedHeader.body?.data?.person).toMatchObject({
      id: otherId,
      status: "MERGED",
      mergedIntoPersonId: subjectId,
    });
  });

  it("uses deterministic bounded keyset pagination without leaking another workspace", async () => {
    const owner = await fixture.createActor();
    const foreignOwner = await fixture.createActor();
    await fixture.createPerson(owner, { displayName: "Zulu" });
    await fixture.createPerson(owner, { displayName: "Alpha" });
    await fixture.createPerson(foreignOwner, { displayName: "Foreign" });
    const filtered = await fixture.execute<{
      people: { nodes: Array<{ displayName: string }> };
    }>({
      jar: owner.jar,
      query: /* GraphQL */ `
        query {
          people(
            first: 10
            filter: { namePrefix: "Al", status: ACTIVE, sensitivity: INTERNAL }
          ) {
            nodes {
              displayName
            }
          }
        }
      `,
    });
    expect(filtered.body?.errors).toBeUndefined();
    expect(filtered.body?.data?.people.nodes).toEqual([
      { displayName: "Alpha" },
    ]);
    const firstPage = await fixture.execute<{
      people: {
        nodes: Array<{ displayName: string; id: string }>;
        pageInfo: { endCursor: string | null; hasNextPage: boolean };
      };
    }>({ jar: owner.jar, query: PEOPLE_QUERY, variables: { first: 1 } });

    expect(
      firstPage.body?.data?.people.nodes.map((row) => row.displayName),
    ).toEqual(["Alpha"]);
    expect(firstPage.body?.data?.people.pageInfo.hasNextPage).toBe(true);
    expect(firstPage.body?.data?.people.pageInfo.endCursor).toEqual(
      expect.any(String),
    );

    const secondPage = await fixture.execute<{
      people: {
        nodes: Array<{ displayName: string; id: string }>;
        pageInfo: { endCursor: string | null; hasNextPage: boolean };
      };
    }>({
      jar: owner.jar,
      query: PEOPLE_QUERY,
      variables: {
        after: firstPage.body?.data?.people.pageInfo.endCursor,
        first: 1,
      },
    });
    expect(
      secondPage.body?.data?.people.nodes.map((row) => row.displayName),
    ).toEqual(["Zulu"]);

    const hidden = await fixture.execute({
      jar: owner.jar,
      query: /* GraphQL */ `
        query ($id: UUID!) {
          person(id: $id) {
            id
          }
        }
      `,
      variables: { id: newId() },
    });
    expect(hidden.body?.errors).toBeUndefined();
    expect(hidden.body?.data).toEqual({ person: null });
  });

  it("applies closed typed filters before tenant-scoped limits", async () => {
    const owner = await fixture.createActor();
    const foreign = await fixture.createActor();
    const person = await fixture.createPerson(owner, {
      displayName: "Typed Filter Subject",
    });
    await fixture.createPerson(foreign, {
      displayName: "Foreign Typed Filter Subject",
    });
    const personId = required(person.body?.data?.createPerson?.person?.id);
    const target = await fixture.createPerson(owner, {
      displayName: "Typed Filter Target",
    });
    const targetId = required(target.body?.data?.createPerson?.person?.id);
    const definitionId = newId();
    const factId = newId();
    const relationshipTypeId = newId();
    const relationshipId = newId();
    const sourceId = newId();
    const evidenceItemId = newId();
    const noteId = newId();
    const tagId = newId();
    await fixture.database.insert(factDefinitions).values({
      id: definitionId,
      workspaceId: owner.workspaceId,
      namespace: "person",
      fieldKey: "typed_filter",
      label: "Typed filter",
      allowedValueType: "text",
      state: "active",
      createdBy: owner.principalId,
      updatedBy: owner.principalId,
    });
    await fixture.database.insert(facts).values({
      id: factId,
      workspaceId: owner.workspaceId,
      personId,
      factDefinitionId: definitionId,
      namespace: "person",
      fieldKey: "typed_filter",
      label: "Typed filter",
      valueType: "text",
      valueText: "match",
      createdBy: owner.principalId,
      updatedBy: owner.principalId,
    });
    await fixture.database.insert(relationshipTypes).values({
      id: relationshipTypeId,
      workspaceId: owner.workspaceId,
      namespace: "person",
      key: "typed_filter",
      forwardLabel: "matches",
      inverseLabel: "matched by",
      createdBy: owner.principalId,
      updatedBy: owner.principalId,
    });
    await fixture.database.insert(relationships).values({
      id: relationshipId,
      workspaceId: owner.workspaceId,
      sourcePersonId: personId,
      targetPersonId: targetId,
      relationshipTypeId,
      createdBy: owner.principalId,
      updatedBy: owner.principalId,
    });
    await fixture.database.insert(sources).values({
      id: sourceId,
      workspaceId: owner.workspaceId,
      kind: "archive",
      title: "Typed filter source",
      createdBy: owner.principalId,
      updatedBy: owner.principalId,
    });
    await fixture.database.insert(evidenceItems).values({
      id: evidenceItemId,
      workspaceId: owner.workspaceId,
      sourceId,
      checksum: `sha256:${"a".repeat(64)}`,
      reviewState: "accepted",
      createdBy: owner.principalId,
      updatedBy: owner.principalId,
    });
    await fixture.database.insert(notes).values({
      id: noteId,
      workspaceId: owner.workspaceId,
      personId,
      plainText: "Typed filter note",
      createdBy: owner.principalId,
      updatedBy: owner.principalId,
    });
    await fixture.database.insert(tags).values({
      id: tagId,
      workspaceId: owner.workspaceId,
      name: "Typed Filter Tag",
      normalizedName: "typed filter tag",
      createdBy: owner.principalId,
      updatedBy: owner.principalId,
    });
    await fixture.database.insert(factDefinitions).values({
      id: newId(),
      workspaceId: foreign.workspaceId,
      namespace: "person",
      fieldKey: "typed_filter",
      label: "Foreign typed filter",
      allowedValueType: "text",
      state: "active",
      createdBy: foreign.principalId,
      updatedBy: foreign.principalId,
    });
    await fixture.database.insert(relationshipTypes).values({
      id: newId(),
      workspaceId: foreign.workspaceId,
      namespace: "person",
      key: "typed_filter",
      forwardLabel: "foreign",
      inverseLabel: "foreign",
      createdBy: foreign.principalId,
      updatedBy: foreign.principalId,
    });
    const now = new Date();
    const result = await fixture.execute<{
      people: { nodes: Array<{ id: string }> };
      factDefinitions: { nodes: Array<{ id: string }> };
      facts: { nodes: Array<{ id: string }> };
      relationshipTypes: { nodes: Array<{ id: string }> };
      relationships: { nodes: Array<{ id: string }> };
      sources: { nodes: Array<{ id: string }> };
      evidenceItems: { nodes: Array<{ id: string }> };
      notes: { nodes: Array<{ id: string }> };
      tags: { nodes: Array<{ id: string }> };
      auditEvents: { nodes: Array<{ resourceId: string | null }> };
      foreignPeople: { nodes: Array<{ id: string }> };
    }>({
      jar: owner.jar,
      query: /* GraphQL */ `
        query ($at: DateTime!, $from: DateTime!, $until: DateTime!) {
          people(first: 10, filter: { nameContains: "Filter Sub", status: ACTIVE, sensitivity: INTERNAL }) { nodes { id } }
          foreignPeople: people(first: 10, filter: { nameContains: "Foreign Typed" }) { nodes { id } }
          factDefinitions(first: 10, filter: { namespace: "person", fieldKey: "typed_filter", state: ACTIVE, allowedValueType: TEXT, cardinality: ONE, searchable: false, filterable: false, graphable: false, defaultSensitivity: INTERNAL }) { nodes { id } }
          facts(first: 10, filter: { personId: "${personId}", definitionId: "${definitionId}", namespace: "person", fieldKey: "typed_filter", state: ASSERTED, reviewState: UNREVIEWED, sensitivity: INTERNAL }) { nodes { id } }
          relationshipTypes(first: 10, filter: { namespace: "person", key: "typed_filter", state: ACTIVE, directed: true, allowsSelf: false, allowedMultiplicity: MANY_TO_MANY }) { nodes { id } }
          relationships(first: 10, filter: { personId: "${personId}", relationshipTypeId: "${relationshipTypeId}", state: ASSERTED, sensitivity: INTERNAL, activeAt: $at }) { nodes { id } }
          sources(first: 10, filter: { kind: "archive", sensitivity: INTERNAL }) { nodes { id } }
          evidenceItems(first: 10, filter: { sourceId: "${sourceId}", reviewState: ACCEPTED, sensitivity: INTERNAL }) { nodes { id } }
          notes(first: 10, filter: { subject: { personId: "${personId}" }, sensitivity: INTERNAL }) { nodes { id } }
          tags(first: 10, filter: { normalizedNamePrefix: "typed" }) { nodes { id } }
          auditEvents(first: 10, filter: { action: "person.create", resourceKind: "person", resourceId: "${personId}", outcome: SUCCESS, occurredFrom: $from, occurredUntil: $until }) { nodes { resourceId } }
        }
      `,
      variables: {
        at: now.toISOString(),
        from: new Date(now.getTime() - 60_000).toISOString(),
        until: new Date(now.getTime() + 60_000).toISOString(),
      },
    });
    expect(
      result.body?.errors,
      JSON.stringify(fixture.capturedLogs),
    ).toBeUndefined();
    expect(result.body?.data).toMatchObject({
      people: { nodes: [{ id: personId }] },
      foreignPeople: { nodes: [] },
      factDefinitions: { nodes: [{ id: definitionId }] },
      facts: { nodes: [{ id: factId }] },
      relationshipTypes: { nodes: [{ id: relationshipTypeId }] },
      relationships: { nodes: [{ id: relationshipId }] },
      sources: { nodes: [{ id: sourceId }] },
      evidenceItems: { nodes: [{ id: evidenceItemId }] },
      notes: { nodes: [{ id: noteId }] },
      tags: { nodes: [{ id: tagId }] },
      auditEvents: { nodes: [{ resourceId: personId }] },
    });

    const invalid = await fixture.execute({
      jar: owner.jar,
      query: /* GraphQL */ `
        query ($prefix: String!) {
          people(first: 1, filter: { namePrefix: $prefix }) {
            nodes {
              id
            }
          }
        }
      `,
      variables: { prefix: "x".repeat(201) },
    });
    expect(invalid.body?.errors?.[0]?.extensions?.code).toBe(
      "VALIDATION_FAILED",
    );
    const invalidCatalog = await fixture.execute({
      jar: owner.jar,
      query: /* GraphQL */ `
        query ($namespace: String!) {
          factDefinitions(first: 1, filter: { namespace: $namespace }) {
            nodes {
              id
            }
          }
        }
      `,
      variables: { namespace: "x".repeat(201) },
    });
    expect(invalidCatalog.body?.errors?.[0]?.extensions?.code).toBe(
      "VALIDATION_FAILED",
    );
    const untypedCatalog = await fixture.execute({
      jar: owner.jar,
      query: /* GraphQL */ `
        query {
          relationshipTypes(first: 1, filter: { metadata: {} }) {
            nodes {
              id
            }
          }
        }
      `,
    });
    expect(untypedCatalog.body?.errors?.[0]?.extensions?.code).toBe(
      "VALIDATION_FAILED",
    );
  });

  it("updates temporal relationships atomically and filters historical edges", async () => {
    const owner = await fixture.createActor();
    const source = await fixture.createPerson(owner, {
      displayName: "Temporal source",
    });
    const target = await fixture.createPerson(owner, {
      displayName: "Temporal target",
    });
    const sourceId = required(source.body?.data?.createPerson?.person?.id);
    const targetId = required(target.body?.data?.createPerson?.person?.id);
    const type = await fixture.execute<{
      createRelationshipType: { relationshipType: { id: string } | null };
    }>({
      jar: owner.jar,
      query: /* GraphQL */ `
        mutation ($input: CreateRelationshipTypeInput!) {
          createRelationshipType(input: $input) {
            relationshipType {
              id
            }
          }
        }
      `,
      variables: {
        input: {
          key: "temporal-history",
          forwardLabel: "worked with",
          inverseLabel: "worked with",
        },
      },
    });
    const relationshipTypeId = required(
      type.body?.data?.createRelationshipType.relationshipType?.id,
    );
    const create = async (input: Record<string, unknown>) =>
      fixture.execute<{
        createRelationship: {
          relationship: { id: string; version: number } | null;
          code: string | null;
          issues: Array<{ code: string; path: string[] }>;
        };
      }>({
        jar: owner.jar,
        query: /* GraphQL */ `
          mutation ($input: CreateRelationshipInput!) {
            createRelationship(input: $input) {
              relationship {
                id
                version
              }
              code
              issues {
                code
                path
              }
            }
          }
        `,
        variables: {
          input: {
            sourcePersonId: sourceId,
            targetPersonId: targetId,
            relationshipTypeId,
            ...input,
          },
        },
      });
    const historical = await create({
      temporalSemantics: "BETWEEN",
      temporalPrecision: "RANGE",
      validFrom: "2020-01-01T00:00:00.000Z",
      validUntil: "2020-12-31T23:59:59.000Z",
    });
    const current = await create({
      temporalSemantics: "BETWEEN",
      temporalPrecision: "RANGE",
      validFrom: "2025-01-01T00:00:00.000Z",
      validUntil: "2025-12-31T23:59:59.000Z",
    });
    expect(historical.body?.errors).toBeUndefined();
    expect(current.body?.errors).toBeUndefined();
    const relationshipId = required(
      historical.body?.data?.createRelationship.relationship?.id,
    );
    const currentId = required(
      current.body?.data?.createRelationship.relationship?.id,
    );
    const update = (input: Record<string, unknown>) =>
      fixture.execute<{
        updateRelationship: {
          relationship: {
            id: string;
            version: number;
            temporalSemantics: string;
            temporalPrecision: string;
            validFrom: string | null;
            validUntil: string | null;
          } | null;
          code: string | null;
          issues: Array<{ code: string; path: string[] }>;
        };
      }>({
        jar: owner.jar,
        query: /* GraphQL */ `
          mutation ($input: UpdateRelationshipInput!) {
            updateRelationship(input: $input) {
              relationship {
                id
                version
                temporalSemantics
                temporalPrecision
                validFrom
                validUntil
              }
              code
              issues {
                code
                path
              }
            }
          }
        `,
        variables: { input: { id: relationshipId, ...input } },
      });
    const partial = await update({
      expectedVersion: 1,
      validUntil: "2021-12-31T23:59:59.000Z",
    });
    expect(partial.body?.errors).toBeUndefined();
    expect(partial.body?.data?.updateRelationship).toMatchObject({
      code: null,
      issues: [],
      relationship: {
        id: relationshipId,
        version: 2,
        temporalSemantics: "BETWEEN",
        temporalPrecision: "RANGE",
        validFrom: "2020-01-01T00:00:00.000Z",
        validUntil: "2021-12-31T23:59:59.000Z",
      },
    });
    const invalid = await update({
      expectedVersion: 2,
      validUntil: "2019-12-31T23:59:59.000Z",
    });
    expect(invalid.body?.errors).toBeUndefined();
    expect(invalid.body?.data?.updateRelationship).toMatchObject({
      code: "VALIDATION_FAILED",
      relationship: null,
      issues: [{ code: "INVALID_TEMPORAL", path: ["temporal"] }],
    });
    const [unchanged] = await fixture.database
      .select({
        version: relationships.version,
        temporalSemantics: relationships.temporalSemantics,
        temporalPrecision: relationships.temporalPrecision,
        validFrom: relationships.validFrom,
        validUntil: relationships.validUntil,
      })
      .from(relationships)
      .where(eq(relationships.id, relationshipId));
    expect(unchanged).toMatchObject({
      version: 2,
      temporalSemantics: "between",
      temporalPrecision: "range",
      validFrom: new Date("2020-01-01T00:00:00.000Z"),
      validUntil: new Date("2021-12-31T23:59:59.000Z"),
    });
    expect(
      await fixture.database
        .select({ id: auditEvents.id })
        .from(auditEvents)
        .where(
          and(
            eq(auditEvents.resourceId, relationshipId),
            eq(auditEvents.action, "relationship.update"),
          ),
        ),
    ).toHaveLength(1);
    const activeAt = async (at: string) =>
      fixture.execute<{
        relationships: { nodes: Array<{ id: string }> };
      }>({
        jar: owner.jar,
        query: /* GraphQL */ `
          query ($at: DateTime!) {
            relationships(
              first: 10
              filter: { personId: "${sourceId}", activeAt: $at }
            ) {
              nodes {
                id
              }
            }
          }
        `,
        variables: { at },
      });
    const duringHistorical = await activeAt("2020-06-01T00:00:00.000Z");
    const duringCurrent = await activeAt("2025-06-01T00:00:00.000Z");
    expect(duringHistorical.body?.errors).toBeUndefined();
    expect(duringCurrent.body?.errors).toBeUndefined();
    expect(
      duringHistorical.body?.data?.relationships.nodes.map((row) => row.id),
    ).toEqual([relationshipId]);
    expect(
      duringCurrent.body?.data?.relationships.nodes.map((row) => row.id),
    ).toEqual([currentId]);
    const cleared = await update({
      expectedVersion: 2,
      temporalSemantics: null,
      temporalPrecision: null,
      validFrom: null,
      validUntil: null,
    });
    expect(cleared.body?.errors).toBeUndefined();
    expect(cleared.body?.data?.updateRelationship).toMatchObject({
      code: null,
      issues: [],
      relationship: {
        id: relationshipId,
        version: 3,
        temporalSemantics: "UNKNOWN",
        temporalPrecision: "UNKNOWN",
        validFrom: null,
        validUntil: null,
      },
    });
  });

  it("commits one redacted audit event with the person and rolls both back on audit failure", async () => {
    const owner = await fixture.createActor();
    const success = await fixture.createPerson(owner, {
      biography: "private biography must not enter audit",
      displayName: "Audited Person",
    });
    const personId = success.body?.data?.createPerson?.person?.id;
    expect(personId).toEqual(expect.any(String));

    const auditRows = await fixture.database.select().from(auditEvents);
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]).toMatchObject({
      action: "person.create",
      actorUserId: owner.userId,
      apiKeyId: null,
      outcome: "success",
      resourceId: personId,
      resourceKind: "person",
      sessionId: expect.any(String),
      workspaceId: owner.workspaceId,
    });
    expect(JSON.stringify(auditRows[0]?.redactedDiff)).not.toContain(
      "private biography",
    );

    await fixture.connection.unsafe(`
      CREATE OR REPLACE FUNCTION public.task8_reject_audit() RETURNS trigger
      LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'forced audit failure'; END $$;
      CREATE TRIGGER task8_reject_audit_trigger
      BEFORE INSERT ON public.audit_events
      FOR EACH ROW EXECUTE FUNCTION public.task8_reject_audit();
    `);
    const rolledBack = await fixture.createPerson(owner, {
      displayName: "Must Roll Back",
    });
    expect(rolledBack.body?.errors?.[0]?.extensions?.code).toBe("INTERNAL");
    const persisted = await fixture.database.select().from(people);
    expect(persisted.map((row) => row.displayName)).toEqual(["Audited Person"]);
  });

  it("HUM-FR-009/011/012/013 governs contradictory typed facts and immutable revisions", async () => {
    const owner = await fixture.createActor();
    const personResult = await fixture.createPerson(owner, {
      displayName: "Contradictory Subject",
    });
    const personId = required(
      personResult.body?.data?.createPerson?.person?.id,
    );
    const definition = await fixture.execute<{
      createFactDefinition: { factDefinition: { id: string } | null };
    }>({
      jar: owner.jar,
      query: /* GraphQL */ `
        mutation ($input: CreateFactDefinitionInput!) {
          createFactDefinition(input: $input) {
            code
            issues {
              code
              path
            }
            factDefinition {
              id
              namespace
              fieldKey
              allowedValueType
              version
            }
          }
        }
      `,
      variables: {
        input: {
          namespace: "person",
          fieldKey: "birth-date",
          label: "Date of birth",
          allowedValueType: "DATE",
          cardinality: "MANY",
          state: "ACTIVE",
        },
      },
    });
    expect(definition.body?.errors).toBeUndefined();
    const definitionId = required(
      definition.body?.data?.createFactDefinition.factDefinition?.id,
    );
    const createFact = (state: "ASSERTED" | "DISPUTED", dateStart: string) =>
      fixture.execute<{
        createFact: {
          fact: { id: string; state: string; version: number } | null;
        };
      }>({
        jar: owner.jar,
        query: /* GraphQL */ `
          mutation ($input: CreateFactInput!) {
            createFact(input: $input) {
              code
              issues {
                code
                path
              }
              fact {
                id
                state
                version
                value {
                  dateStart
                }
                revisions(first: 10) {
                  nodes {
                    revision
                  }
                }
              }
            }
          }
        `,
        variables: {
          input: {
            personId,
            definitionId,
            state,
            value: { dateStart },
            temporalSemantics: "EXACT",
            temporalPrecision: "DAY",
            validEarliestAt: `${dateStart}T00:00:00.000Z`,
          },
        },
      });
    const first = await createFact("ASSERTED", "1815-12-10");
    const second = await createFact("DISPUTED", "1815-12-11");
    expect(first.body?.errors).toBeUndefined();
    expect(second.body?.errors).toBeUndefined();
    expect(first.body?.data?.createFact).toMatchObject({
      code: null,
      issues: [],
      fact: { version: 1 },
    });
    expect(second.body?.data?.createFact).toMatchObject({
      code: null,
      issues: [],
      fact: { version: 1 },
    });
    const firstId = required(first.body?.data?.createFact.fact?.id);

    const personFacts = await fixture.execute<{
      person: { facts: { nodes: Array<{ id: string; state: string }> } } | null;
    }>({
      jar: owner.jar,
      query: /* GraphQL */ `
        query ($id: UUID!) {
          person(id: $id) {
            facts(first: 10) {
              nodes {
                id
                state
              }
            }
          }
        }
      `,
      variables: { id: personId },
    });
    expect(personFacts.body?.data?.person?.facts.nodes).toHaveLength(2);
    expect(
      personFacts.body?.data?.person?.facts.nodes.map((fact) => fact.state),
    ).toEqual(expect.arrayContaining(["ASSERTED", "DISPUTED"]));

    const revise = (reason: string) =>
      fixture.execute<{
        reviseFact: {
          code: string | null;
          currentVersion?: number | null;
          fact: { id: string; version: number } | null;
        };
      }>({
        jar: owner.jar,
        query: /* GraphQL */ `
          mutation ($input: ReviseFactInput!) {
            reviseFact(input: $input) {
              code
              currentVersion
              issues {
                code
                path
              }
              fact {
                id
                version
                revisions(first: 10) {
                  nodes {
                    revision
                    changeReason
                  }
                }
              }
            }
          }
        `,
        variables: {
          input: {
            id: firstId,
            expectedVersion: 1,
            confidence: 0.8,
            changeReason: reason,
          },
        },
      });
    const [revisionA, revisionB] = await Promise.all([
      revise("first concurrent revision"),
      revise("second concurrent revision"),
    ]);
    const results = [
      revisionA.body?.data?.reviseFact,
      revisionB.body?.data?.reviseFact,
    ];
    expect(
      results.filter((result) => result?.fact?.version === 2),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result?.code === "CONFLICT"),
    ).toHaveLength(1);
    expect(
      await fixture.database
        .select({ id: auditEvents.id })
        .from(auditEvents)
        .where(
          and(
            eq(auditEvents.resourceId, firstId),
            eq(auditEvents.action, "fact.revise"),
          ),
        ),
    ).toHaveLength(1);

    const fact = await fixture.execute<{
      fact: { revisions: { nodes: Array<{ revision: number }> } } | null;
    }>({
      jar: owner.jar,
      query: /* GraphQL */ `
        query ($id: UUID!) {
          fact(id: $id) {
            revisions(first: 10) {
              nodes {
                revision
              }
            }
          }
        }
      `,
      variables: { id: firstId },
    });
    expect(
      fact.body?.data?.fact?.revisions.nodes.map((row) => row.revision),
    ).toEqual([2, 1]);

    const source = await fixture.execute<{
      createSource: { source: { id: string } | null };
    }>({
      jar: owner.jar,
      query: /* GraphQL */ `
        mutation ($input: CreateSourceInput!) {
          createSource(input: $input) {
            source {
              id
            }
          }
        }
      `,
      variables: { input: { kind: "archive", title: "Rollback source" } },
    });
    const sourceId = required(source.body?.data?.createSource.source?.id);
    const createEvidence = async (checksum: string) =>
      required(
        (
          await fixture.execute<{
            createEvidenceItem: { evidenceItem: { id: string } | null };
          }>({
            jar: owner.jar,
            query: /* GraphQL */ `
              mutation ($input: CreateEvidenceItemInput!) {
                createEvidenceItem(input: $input) {
                  evidenceItem {
                    id
                  }
                }
              }
            `,
            variables: { input: { sourceId, checksum } },
          })
        ).body?.data?.createEvidenceItem.evidenceItem?.id,
      );
    const linkedEvidenceId = await createEvidence(`sha256:${"8".repeat(64)}`);
    const newEvidenceId = await createEvidence(`sha256:${"9".repeat(64)}`);
    const linkDocument = /* GraphQL */ `
      mutation ($input: LinkFactEvidenceInput!) {
        linkFactEvidence(input: $input) {
          factEvidence {
            id
          }
        }
      }
    `;
    await fixture.execute({
      jar: owner.jar,
      query: linkDocument,
      variables: {
        input: { factId: firstId, evidenceItemId: linkedEvidenceId },
      },
    });
    const beforeAuditFailure = {
      audits: (await fixture.database.select().from(auditEvents)).length,
      revisions: (
        await fixture.database
          .select()
          .from(factRevisions)
          .where(eq(factRevisions.factId, firstId))
      ).length,
    };
    await fixture.connection.unsafe(`
      CREATE OR REPLACE FUNCTION public.task8_reject_research_audit() RETURNS trigger
      LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'forced research audit failure'; END $$;
      CREATE TRIGGER task8_reject_research_audit_trigger
      BEFORE INSERT ON public.audit_events
      FOR EACH ROW EXECUTE FUNCTION public.task8_reject_research_audit();
    `);
    const failedRevision = await fixture.execute({
      jar: owner.jar,
      query: /* GraphQL */ `
        mutation ($input: ReviseFactInput!) {
          reviseFact(input: $input) {
            fact {
              id
            }
            code
          }
        }
      `,
      variables: {
        input: { id: firstId, expectedVersion: 2, confidence: 0.7 },
      },
    });
    const failedLink = await fixture.execute({
      jar: owner.jar,
      query: linkDocument,
      variables: {
        input: { factId: firstId, evidenceItemId: newEvidenceId },
      },
    });
    const failedUnlink = await fixture.execute({
      jar: owner.jar,
      query: /* GraphQL */ `
        mutation ($input: UnlinkFactEvidenceInput!) {
          unlinkFactEvidence(input: $input) {
            factEvidence {
              id
            }
          }
        }
      `,
      variables: {
        input: { factId: firstId, evidenceItemId: linkedEvidenceId },
      },
    });
    for (const result of [failedRevision, failedLink, failedUnlink])
      expect(result.body?.errors?.[0]?.extensions?.code).toBe("INTERNAL");
    const [afterFact] = await fixture.database
      .select({ version: facts.version })
      .from(facts)
      .where(eq(facts.id, firstId));
    expect(afterFact?.version).toBe(2);
    expect(
      await fixture.database
        .select()
        .from(factRevisions)
        .where(eq(factRevisions.factId, firstId)),
    ).toHaveLength(beforeAuditFailure.revisions);
    expect(await fixture.database.select().from(auditEvents)).toHaveLength(
      beforeAuditFailure.audits,
    );
    expect(
      await fixture.database
        .select({ evidenceItemId: factEvidence.evidenceItemId })
        .from(factEvidence)
        .where(eq(factEvidence.factId, firstId)),
    ).toEqual([{ evidenceItemId: linkedEvidenceId }]);
  });

  it("revalidates revisions and relationship updates against locked definitions", async () => {
    const owner = await fixture.createActor();
    const personA = await fixture.createPerson(owner, {
      displayName: "Locked validation A",
    });
    const personB = await fixture.createPerson(owner, {
      displayName: "Locked validation B",
    });
    const personAId = required(personA.body?.data?.createPerson?.person?.id);
    const personBId = required(personB.body?.data?.createPerson?.person?.id);
    const definition = await fixture.execute<{
      createFactDefinition: { factDefinition: { id: string } | null };
    }>({
      jar: owner.jar,
      query: /* GraphQL */ `
        mutation ($input: CreateFactDefinitionInput!) {
          createFactDefinition(input: $input) {
            factDefinition {
              id
            }
          }
        }
      `,
      variables: {
        input: {
          namespace: "person",
          fieldKey: "locked_json",
          label: "Locked JSON",
          allowedValueType: "JSON",
          validationSchema: {
            type: "object",
            required: ["approved"],
            properties: { approved: { const: true } },
            additionalProperties: false,
          },
          state: "ACTIVE",
        },
      },
    });
    const fact = await fixture.execute<{
      createFact: { fact: { id: string; version: number } | null };
    }>({
      jar: owner.jar,
      query: /* GraphQL */ `
        mutation ($input: CreateFactInput!) {
          createFact(input: $input) {
            fact {
              id
              version
            }
          }
        }
      `,
      variables: {
        input: {
          personId: personAId,
          definitionId:
            definition.body?.data?.createFactDefinition.factDefinition?.id,
          value: { json: { approved: true } },
        },
      },
    });
    const factId = required(fact.body?.data?.createFact.fact?.id);
    const revise = (value: unknown) =>
      fixture.execute<{
        reviseFact: {
          code: string | null;
          fact: { id: string; version: number } | null;
          issues: Array<{ code: string }>;
        };
      }>({
        jar: owner.jar,
        query: /* GraphQL */ `
          mutation ($input: ReviseFactInput!) {
            reviseFact(input: $input) {
              fact {
                id
                version
              }
              code
              issues {
                code
                path
              }
            }
          }
        `,
        variables: {
          input: { id: factId, expectedVersion: 1, value: { json: value } },
        },
      });
    const invalidRevision = await revise({ approved: false });
    expect(invalidRevision.body?.errors).toBeUndefined();
    expect(invalidRevision.body?.data?.reviseFact).toMatchObject({
      code: "VALIDATION_FAILED",
      fact: null,
      issues: [{ code: "SCHEMA_VALIDATION" }],
    });
    const [unchangedFact] = await fixture.database
      .select({ version: facts.version, valueJson: facts.valueJson })
      .from(facts)
      .where(eq(facts.id, factId));
    expect(unchangedFact).toEqual({
      version: 1,
      valueJson: { approved: true },
    });
    expect(
      await fixture.database
        .select({ id: factRevisions.id })
        .from(factRevisions)
        .where(eq(factRevisions.factId, factId)),
    ).toHaveLength(1);
    expect(
      await fixture.database
        .select({ id: auditEvents.id })
        .from(auditEvents)
        .where(
          and(
            eq(auditEvents.resourceId, factId),
            eq(auditEvents.action, "fact.revise"),
          ),
        ),
    ).toEqual([]);
    const validRevision = await revise({ approved: true });
    expect(validRevision.body?.errors).toBeUndefined();
    expect(validRevision.body?.data?.reviseFact).toMatchObject({
      code: null,
      fact: { id: factId, version: 2 },
      issues: [],
    });

    const relationshipType = await fixture.execute<{
      createRelationshipType: { relationshipType: { id: string } | null };
    }>({
      jar: owner.jar,
      query: /* GraphQL */ `
        mutation ($input: CreateRelationshipTypeInput!) {
          createRelationshipType(input: $input) {
            relationshipType {
              id
            }
          }
        }
      `,
      variables: {
        input: {
          key: "locked_metadata",
          forwardLabel: "validates",
          inverseLabel: "validated by",
          metadataSchema: {
            type: "object",
            required: ["approved"],
            properties: { approved: { const: true } },
            additionalProperties: false,
          },
        },
      },
    });
    const relationship = await fixture.execute<{
      createRelationship: { relationship: { id: string } | null };
    }>({
      jar: owner.jar,
      query: /* GraphQL */ `
        mutation ($input: CreateRelationshipInput!) {
          createRelationship(input: $input) {
            relationship {
              id
              version
            }
            code
            issues {
              code
            }
          }
        }
      `,
      variables: {
        input: {
          sourcePersonId: personAId,
          targetPersonId: personBId,
          relationshipTypeId:
            relationshipType.body?.data?.createRelationshipType.relationshipType
              ?.id,
          metadata: { approved: true },
        },
      },
    });
    const relationshipId = required(
      relationship.body?.data?.createRelationship.relationship?.id,
    );
    const updateRelationship = (patch: Record<string, unknown>) =>
      fixture.execute<{
        updateRelationship: {
          code: string | null;
          relationship: { id: string; version: number } | null;
          issues: Array<{ code: string }>;
        };
      }>({
        jar: owner.jar,
        query: /* GraphQL */ `
          mutation ($input: UpdateRelationshipInput!) {
            updateRelationship(input: $input) {
              relationship {
                id
                version
              }
              code
              issues {
                code
                path
              }
            }
          }
        `,
        variables: {
          input: { id: relationshipId, expectedVersion: 1, ...patch },
        },
      });
    for (const patch of [
      { metadata: { approved: false } },
      { state: "not_a_relationship_state" },
    ]) {
      const invalid = await updateRelationship(patch);
      expect(invalid.body?.errors).toBeUndefined();
      expect(invalid.body?.data?.updateRelationship).toMatchObject({
        code: "VALIDATION_FAILED",
        relationship: null,
      });
    }
    const [unchangedRelationship] = await fixture.database
      .select({
        metadata: relationships.metadata,
        state: relationships.state,
        version: relationships.version,
      })
      .from(relationships)
      .where(eq(relationships.id, relationshipId));
    expect(unchangedRelationship).toEqual({
      metadata: { approved: true },
      state: "asserted",
      version: 1,
    });
    expect(
      await fixture.database
        .select({ id: auditEvents.id })
        .from(auditEvents)
        .where(
          and(
            eq(auditEvents.resourceId, relationshipId),
            eq(auditEvents.action, "relationship.update"),
          ),
        ),
    ).toEqual([]);
    const validRelationship = await updateRelationship({
      metadata: { approved: true },
      state: "CORROBORATED",
    });
    expect(validRelationship.body?.errors).toBeUndefined();
    expect(validRelationship.body?.data?.updateRelationship).toMatchObject({
      code: null,
      relationship: { id: relationshipId, version: 2 },
      issues: [],
    });
  });

  it("preserves directed endpoints and canonicalizes undirected relationship endpoints", async () => {
    const owner = await fixture.createActor();
    const first = await fixture.createPerson(owner, { displayName: "First" });
    const second = await fixture.createPerson(owner, { displayName: "Second" });
    const firstId = required(first.body?.data?.createPerson?.person?.id);
    const secondId = required(second.body?.data?.createPerson?.person?.id);
    const createType = async (key: string, directed: boolean) =>
      fixture.execute<{
        createRelationshipType: { relationshipType: { id: string } | null };
      }>({
        jar: owner.jar,
        query: /* GraphQL */ `
          mutation ($input: CreateRelationshipTypeInput!) {
            createRelationshipType(input: $input) {
              code
              issues {
                code
                path
              }
              relationshipType {
                id
                key
                directed
                allowsSelf
                allowedMultiplicity
              }
            }
          }
        `,
        variables: {
          input: {
            namespace: "social",
            key,
            forwardLabel: key,
            inverseLabel: `${key}-inverse`,
            directed,
            allowsSelf: false,
            allowedMultiplicity: "MANY_TO_MANY",
            metadataSchema: {
              type: "object",
              properties: { context: { type: "string" } },
              additionalProperties: false,
            },
          },
        },
      });
    const directedType = await createType("reports-to", true);
    const undirectedType = await createType("knows", false);
    const createRelationship = (
      relationshipTypeId: string,
      sourcePersonId: string,
      targetPersonId: string,
    ) =>
      fixture.execute<{
        createRelationship: {
          code: string | null;
          relationship: {
            sourcePersonId: string;
            targetPersonId: string;
          } | null;
        };
      }>({
        jar: owner.jar,
        query: /* GraphQL */ `
          mutation ($input: CreateRelationshipInput!) {
            createRelationship(input: $input) {
              code
              issues {
                code
                path
              }
              relationship {
                id
                sourcePersonId
                targetPersonId
                metadata
                version
              }
            }
          }
        `,
        variables: {
          input: {
            relationshipTypeId,
            sourcePersonId,
            targetPersonId,
            metadata: { context: "research" },
          },
        },
      });
    const directed = await createRelationship(
      required(
        directedType.body?.data?.createRelationshipType.relationshipType?.id,
      ),
      secondId,
      firstId,
    );
    expect(directed.body?.data?.createRelationship.relationship).toMatchObject({
      sourcePersonId: secondId,
      targetPersonId: firstId,
    });
    const undirected = await createRelationship(
      required(
        undirectedType.body?.data?.createRelationshipType.relationshipType?.id,
      ),
      secondId,
      firstId,
    );
    expect(
      undirected.body?.data?.createRelationship.relationship,
    ).toMatchObject({
      sourcePersonId: [firstId, secondId].sort()[0],
      targetPersonId: [firstId, secondId].sort()[1],
    });
    const self = await createRelationship(
      required(
        directedType.body?.data?.createRelationshipType.relationshipType?.id,
      ),
      firstId,
      firstId,
    );
    expect(self.body?.data?.createRelationship).toMatchObject({
      code: "VALIDATION_FAILED",
      relationship: null,
    });
  });

  it("HUM-FR-013 creates evidence citations, sanitized notes, normalized tags, and safe audit browsing", async () => {
    const owner = await fixture.createActor();
    const person = await fixture.createPerson(owner, {
      displayName: "Evidence Subject",
    });
    const personId = required(person.body?.data?.createPerson?.person?.id);
    const definition = await fixture.execute<{
      createFactDefinition: { factDefinition: { id: string } | null };
    }>({
      jar: owner.jar,
      query: /* GraphQL */ `
        mutation ($input: CreateFactDefinitionInput!) {
          createFactDefinition(input: $input) {
            factDefinition {
              id
            }
            code
            issues {
              code
            }
          }
        }
      `,
      variables: {
        input: {
          namespace: "person",
          fieldKey: "occupation",
          label: "Occupation",
          allowedValueType: "TEXT",
          state: "ACTIVE",
        },
      },
    });
    const fact = await fixture.execute<{
      createFact: { fact: { id: string } | null };
    }>({
      jar: owner.jar,
      query: /* GraphQL */ `
        mutation ($input: CreateFactInput!) {
          createFact(input: $input) {
            fact {
              id
            }
            code
            issues {
              code
            }
          }
        }
      `,
      variables: {
        input: {
          personId,
          definitionId:
            definition.body?.data?.createFactDefinition.factDefinition?.id,
          value: { text: "Mathematician" },
        },
      },
    });
    const factId = required(fact.body?.data?.createFact.fact?.id);
    const source = await fixture.execute<{
      createSource: { source: { id: string } | null };
    }>({
      jar: owner.jar,
      query: /* GraphQL */ `
        mutation ($input: CreateSourceInput!) {
          createSource(input: $input) {
            code
            issues {
              code
              path
            }
            source {
              id
              title
              canonicalUrl
              version
            }
          }
        }
      `,
      variables: {
        input: {
          kind: "archive",
          title: "Primary archive",
          canonicalUrl: "https://example.test/archive",
          reliability: 0.9,
        },
      },
    });
    expect(source.body?.data?.createSource.source?.id).toEqual(
      expect.any(String),
    );
    const evidence = await fixture.execute<{
      createEvidenceItem: { evidenceItem: { id: string } | null };
    }>({
      jar: owner.jar,
      query: /* GraphQL */ `
        mutation ($input: CreateEvidenceItemInput!) {
          createEvidenceItem(input: $input) {
            code
            issues {
              code
              path
            }
            evidenceItem {
              id
              checksum
              version
            }
          }
        }
      `,
      variables: {
        input: {
          sourceId: source.body?.data?.createSource.source?.id,
          externalLocator: "https://example.test/archive/item",
          extractedText: "private evidence body",
          checksum: `sha256:${"a".repeat(64)}`,
        },
      },
    });
    const evidenceItemId = required(
      evidence.body?.data?.createEvidenceItem.evidenceItem?.id,
    );
    const excerpt = await fixture.execute({
      jar: owner.jar,
      query: /* GraphQL */ `
        mutation ($input: CreateEvidenceExcerptInput!) {
          createEvidenceExcerpt(input: $input) {
            code
            issues {
              code
            }
            evidenceExcerpt {
              id
              excerpt
              pageNumber
              createdAt
              createdBy {
                kind
              }
            }
          }
        }
      `,
      variables: {
        input: {
          evidenceItemId,
          excerpt: "Cited evidence excerpt",
          pageNumber: 12,
          locator: "p. 12",
          checksum: `sha256:${"b".repeat(64)}`,
        },
      },
    });
    expect(excerpt.body?.errors).toBeUndefined();
    expect(excerpt.body?.data?.createEvidenceExcerpt).toMatchObject({
      code: null,
      evidenceExcerpt: {
        createdAt: expect.any(String),
        createdBy: { kind: "USER" },
      },
    });
    const citation = await fixture.execute({
      jar: owner.jar,
      query: /* GraphQL */ `
        mutation ($input: LinkFactEvidenceInput!) {
          linkFactEvidence(input: $input) {
            code
            issues {
              code
            }
            factEvidence {
              id
              factId
              evidenceItemId
              locator
              supportStrength
              createdAt
              createdBy {
                kind
              }
            }
          }
        }
      `,
      variables: {
        input: {
          factId,
          evidenceItemId,
          excerpt: "Cited evidence excerpt",
          locator: "p. 12",
          supportStrength: 0.75,
        },
      },
    });
    expect(citation.body?.errors).toBeUndefined();
    expect(citation.body?.data).toMatchObject({
      linkFactEvidence: {
        code: null,
        factEvidence: {
          factId,
          evidenceItemId,
          locator: "p. 12",
          supportStrength: 0.75,
          createdAt: expect.any(String),
          createdBy: { kind: "USER" },
        },
      },
    });
    const note = await fixture.execute({
      jar: owner.jar,
      query: /* GraphQL */ `
        mutation ($input: CreateNoteInput!) {
          createNote(input: $input) {
            code
            issues {
              code
            }
            note {
              id
              sanitizedMarkdown
              plainText
              version
            }
          }
        }
      `,
      variables: {
        input: {
          subject: { personId },
          content: { markdown: "hello <script>private()</script> **world**" },
        },
      },
    });
    expect(note.body?.data).toMatchObject({
      createNote: {
        code: null,
        note: {
          sanitizedMarkdown: "hello  **world**",
          plainText: null,
          version: 1,
        },
      },
    });
    const tag = await fixture.execute<{
      createTag: { tag: { id: string; normalizedName: string } | null };
    }>({
      jar: owner.jar,
      query: /* GraphQL */ `
        mutation ($input: CreateTagInput!) {
          createTag(input: $input) {
            code
            issues {
              code
            }
            tag {
              id
              name
              normalizedName
              color
            }
          }
        }
      `,
      variables: { input: { name: "  Résumé   Review ", color: "#aabbcc" } },
    });
    const tagId = required(tag.body?.data?.createTag.tag?.id);
    expect(tag.body?.data?.createTag.tag).toMatchObject({
      normalizedName: "résumé review",
      color: "#AABBCC",
    });
    const associationDocument = /* GraphQL */ `
      mutation ($input: TagPersonInput!) {
        tagPerson(input: $input) {
          code
          issues {
            code
          }
          personTag {
            id
            personId
            tagId
          }
        }
      }
    `;
    const association = await fixture.execute({
      jar: owner.jar,
      query: associationDocument,
      variables: { input: { personId, tagId } },
    });
    const repeated = await fixture.execute({
      jar: owner.jar,
      query: associationDocument,
      variables: { input: { personId, tagId } },
    });
    expect(repeated.body?.data).toEqual(association.body?.data);
    const audit = await fixture.execute<{
      auditEvents: { nodes: Array<{ action: string; redactedDiff: unknown }> };
    }>({
      jar: owner.jar,
      query: /* GraphQL */ `
        query {
          auditEvents(first: 20) {
            nodes {
              id
              action
              resourceKind
              resourceId
              redactedDiff
            }
            pageInfo {
              hasNextPage
            }
          }
        }
      `,
    });
    expect(audit.body?.errors).toBeUndefined();
    expect(
      audit.body?.data?.auditEvents.nodes.map((event) => event.action),
    ).toEqual(
      expect.arrayContaining([
        "source.create",
        "evidence.create",
        "fact.evidence.link",
        "note.create",
        "tag.create",
        "tag.person",
      ]),
    );
    expect(JSON.stringify(audit.body)).not.toContain("private evidence body");
    expect(JSON.stringify(audit.body)).not.toContain("Cited evidence excerpt");
  });

  it("HUM-FR-009 enforces field-selection identity and optimistic replacement versions", async () => {
    const owner = await fixture.createActor();
    const person = await fixture.createPerson(owner, {
      displayName: "Selected subject",
    });
    const other = await fixture.createPerson(owner, {
      displayName: "Other subject",
    });
    const personId = required(person.body?.data?.createPerson?.person?.id);
    const otherId = required(other.body?.data?.createPerson?.person?.id);
    const definition = await fixture.execute<{
      createFactDefinition: { factDefinition: { id: string } | null };
    }>({
      jar: owner.jar,
      query: /* GraphQL */ `
        mutation ($input: CreateFactDefinitionInput!) {
          createFactDefinition(input: $input) {
            factDefinition {
              id
            }
          }
        }
      `,
      variables: {
        input: {
          namespace: "person",
          fieldKey: "birthplace",
          label: "Birthplace",
          allowedValueType: "TEXT",
          cardinality: "MANY",
          state: "ACTIVE",
        },
      },
    });
    const definitionId = required(
      definition.body?.data?.createFactDefinition.factDefinition?.id,
    );
    const create = async (value: string) =>
      fixture.execute<{ createFact: { fact: { id: string } | null } }>({
        jar: owner.jar,
        query: /* GraphQL */ `
          mutation ($input: CreateFactInput!) {
            createFact(input: $input) {
              fact {
                id
              }
              code
              issues {
                code
              }
            }
          }
        `,
        variables: {
          input: { personId, definitionId, value: { text: value } },
        },
      });
    const firstFact = await create("London");
    const secondFact = await create("Paris");
    const factRelationship = await fixture.execute({
      jar: owner.jar,
      query: /* GraphQL */ `
        mutation ($input: CreateFactRelationshipInput!) {
          createFactRelationship(input: $input) {
            factRelationship {
              id
              createdAt
              updatedAt
              createdBy {
                kind
              }
              updatedBy {
                kind
              }
            }
            code
          }
        }
      `,
      variables: {
        input: {
          sourceFactId: required(firstFact.body?.data?.createFact.fact?.id),
          targetFactId: required(secondFact.body?.data?.createFact.fact?.id),
          relationshipType: "SUPPORTS",
        },
      },
    });
    expect(factRelationship.body?.errors).toBeUndefined();
    expect(factRelationship.body?.data?.createFactRelationship).toMatchObject({
      code: null,
      factRelationship: {
        createdAt: expect.any(String),
        updatedAt: expect.any(String),
        createdBy: { kind: "USER" },
        updatedBy: { kind: "USER" },
      },
    });
    const select = (
      factId: string,
      selectedPersonId: string,
      expectedVersion?: number,
      selectionReason?: string,
    ) =>
      fixture.execute<{
        selectPersonField: {
          code: string | null;
          currentVersion?: number | null;
          selection: {
            factId: string;
            version: number;
            createdAt: string;
            updatedAt: string;
            selectedBy: { kind: string };
            createdBy: { kind: string };
            updatedBy: { kind: string };
          } | null;
        };
      }>({
        jar: owner.jar,
        query: /* GraphQL */ `
          mutation ($input: SelectPersonFieldInput!) {
            selectPersonField(input: $input) {
              code
              currentVersion
              issues {
                code
                path
              }
              selection {
                id
                factId
                version
                createdAt
                updatedAt
                selectedBy {
                  kind
                }
                createdBy {
                  kind
                }
                updatedBy {
                  kind
                }
              }
            }
          }
        `,
        variables: {
          input: {
            personId: selectedPersonId,
            namespace: "person",
            fieldKey: "birthplace",
            factId,
            ...(expectedVersion === undefined ? {} : { expectedVersion }),
            ...(selectionReason === undefined ? {} : { selectionReason }),
          },
        },
      });

    const mismatch = await select(
      required(firstFact.body?.data?.createFact.fact?.id),
      otherId,
    );
    expect(mismatch.body?.data?.selectPersonField).toMatchObject({
      code: "VALIDATION_FAILED",
      selection: null,
    });
    const oversizedReason = await select(
      required(firstFact.body?.data?.createFact.fact?.id),
      personId,
      undefined,
      "x".repeat(4_001),
    );
    expect(oversizedReason.body?.data?.selectPersonField).toMatchObject({
      code: "VALIDATION_FAILED",
      selection: null,
    });
    const initial = await select(
      required(firstFact.body?.data?.createFact.fact?.id),
      personId,
      undefined,
      "Reviewed against primary evidence",
    );
    expect(initial.body?.data?.selectPersonField).toMatchObject({
      code: null,
      selection: {
        version: 1,
        createdAt: expect.any(String),
        updatedAt: expect.any(String),
        selectedBy: { kind: "USER" },
        createdBy: { kind: "USER" },
        updatedBy: { kind: "USER" },
      },
    });
    const missingVersion = await select(
      required(secondFact.body?.data?.createFact.fact?.id),
      personId,
    );
    expect(missingVersion.body?.data?.selectPersonField).toMatchObject({
      code: "CONFLICT",
      currentVersion: 1,
      selection: null,
    });
    const replacement = await select(
      required(secondFact.body?.data?.createFact.fact?.id),
      personId,
      1,
    );
    expect(replacement.body?.data?.selectPersonField).toMatchObject({
      code: null,
      selection: {
        factId: secondFact.body?.data?.createFact.fact?.id,
        version: 2,
      },
    });

    const persisted = await fixture.execute<{
      person: {
        fieldSelections: {
          nodes: Array<{
            fact: { id: string; value: { text: string } } | null;
            factId: string;
            fieldKey: string;
            namespace: string;
            selectionReason: string | null;
            selectedBy: { kind: string };
            version: number;
          }>;
          pageInfo: { endCursor: string | null; hasNextPage: boolean };
        };
      } | null;
    }>({
      jar: owner.jar,
      query: /* GraphQL */ `
        query ($personId: UUID!) {
          person(id: $personId) {
            fieldSelections(first: 10) {
              nodes {
                factId
                namespace
                fieldKey
                selectionReason
                version
                selectedBy {
                  kind
                }
                fact {
                  id
                  value {
                    text
                  }
                }
              }
              pageInfo {
                endCursor
                hasNextPage
              }
            }
          }
        }
      `,
      variables: { personId },
    });
    expect(persisted.body?.errors).toBeUndefined();
    expect(persisted.body?.data?.person?.fieldSelections).toEqual({
      nodes: [
        {
          fact: {
            id: required(secondFact.body?.data?.createFact.fact?.id),
            value: { text: "Paris" },
          },
          factId: required(secondFact.body?.data?.createFact.fact?.id),
          fieldKey: "birthplace",
          namespace: "person",
          selectionReason: null,
          selectedBy: { kind: "USER" },
          version: 2,
        },
      ],
      pageInfo: { endCursor: expect.any(String), hasNextPage: false },
    });

    const serial = await fixture.execute<{
      prime: {
        person: {
          fieldSelections: {
            nodes: Array<{ factId: string; version: number }>;
          };
          version: number;
        } | null;
      };
      replace: {
        selection: {
          factId: string;
          person: {
            fieldSelections: {
              nodes: Array<{
                fact: { id: string } | null;
                factId: string;
                version: number;
              }>;
            };
          } | null;
          version: number;
        } | null;
      };
    }>({
      jar: owner.jar,
      query: /* GraphQL */ `
        mutation (
          $person: UpdatePersonInput!
          $selection: SelectPersonFieldInput!
        ) {
          prime: updatePerson(input: $person) {
            person {
              version
              fieldSelections(first: 10) {
                nodes {
                  factId
                  version
                }
              }
            }
          }
          replace: selectPersonField(input: $selection) {
            selection {
              factId
              version
              person {
                fieldSelections(first: 10) {
                  nodes {
                    factId
                    version
                    fact {
                      id
                    }
                  }
                }
              }
            }
          }
        }
      `,
      variables: {
        person: {
          id: personId,
          expectedVersion: 1,
          preferredName: "Selection cache prime",
        },
        selection: {
          personId,
          namespace: "person",
          fieldKey: "birthplace",
          factId: required(firstFact.body?.data?.createFact.fact?.id),
          expectedVersion: 2,
          selectionReason: "Serial replacement",
        },
      },
    });
    expect(serial.body?.errors).toBeUndefined();
    expect(serial.body?.data?.prime.person).toMatchObject({
      version: 2,
      fieldSelections: {
        nodes: [
          {
            factId: required(secondFact.body?.data?.createFact.fact?.id),
            version: 2,
          },
        ],
      },
    });
    expect(serial.body?.data?.replace.selection).toEqual({
      factId: required(firstFact.body?.data?.createFact.fact?.id),
      person: {
        fieldSelections: {
          nodes: [
            {
              fact: {
                id: required(firstFact.body?.data?.createFact.fact?.id),
              },
              factId: required(firstFact.body?.data?.createFact.fact?.id),
              version: 3,
            },
          ],
        },
      },
      version: 3,
    });

    const fresh = await fixture.execute<{
      person: {
        fieldSelections: {
          nodes: Array<{
            factId: string;
            selectionReason: string;
            version: number;
          }>;
        };
      } | null;
    }>({
      jar: owner.jar,
      query: /* GraphQL */ `
        query ($personId: UUID!) {
          person(id: $personId) {
            fieldSelections(first: 10) {
              nodes {
                factId
                selectionReason
                version
              }
            }
          }
        }
      `,
      variables: { personId },
    });
    expect(fresh.body?.errors).toBeUndefined();
    expect(fresh.body?.data?.person?.fieldSelections.nodes).toEqual([
      {
        factId: required(firstFact.body?.data?.createFact.fact?.id),
        selectionReason: "Serial replacement",
        version: 3,
      },
    ]);

    const archived = await fixture.execute<{
      archive: {
        person: {
          fieldSelections: { nodes: Array<{ factId: string }> };
          status: string;
        } | null;
      };
      prime: {
        person: {
          fieldSelections: { nodes: Array<{ factId: string }> };
          version: number;
        } | null;
      };
    }>({
      jar: owner.jar,
      query: /* GraphQL */ `
        mutation ($prime: UpdatePersonInput!, $archive: ArchivePersonInput!) {
          prime: updatePerson(input: $prime) {
            person {
              version
              fieldSelections(first: 10) {
                nodes {
                  factId
                }
              }
            }
          }
          archive: archivePerson(input: $archive) {
            person {
              status
              fieldSelections(first: 10) {
                nodes {
                  factId
                }
              }
            }
          }
        }
      `,
      variables: {
        archive: { id: personId, expectedVersion: 3 },
        prime: {
          id: personId,
          expectedVersion: 2,
          preferredName: "Lifecycle cache prime",
        },
      },
    });
    expect(archived.body?.errors).toBeUndefined();
    expect(archived.body?.data?.prime.person).toMatchObject({
      version: 3,
      fieldSelections: {
        nodes: [
          { factId: required(firstFact.body?.data?.createFact.fact?.id) },
        ],
      },
    });
    expect(archived.body?.data?.archive.person).toEqual({
      fieldSelections: { nodes: [] },
      status: "ARCHIVED",
    });
    const archivedFresh = await fixture.execute<{
      person: { id: string } | null;
    }>({
      jar: owner.jar,
      query: /* GraphQL */ `
        query ($personId: UUID!) {
          person(id: $personId) {
            id
          }
        }
      `,
      variables: { personId },
    });
    expect(archivedFresh.body?.errors).toBeUndefined();
    expect(archivedFresh.body?.data?.person).toBeNull();
  });

  it("serializes one-to-one multiplicity checks so exactly one concurrent edge wins", async () => {
    const owner = await fixture.createActor();
    const people = await Promise.all(
      ["Source", "Target A", "Target B"].map((displayName) =>
        fixture.createPerson(owner, { displayName }),
      ),
    );
    const ids = people.map((result) =>
      required(result.body?.data?.createPerson?.person?.id),
    );
    const type = await fixture.execute<{
      createRelationshipType: { relationshipType: { id: string } | null };
    }>({
      jar: owner.jar,
      query: /* GraphQL */ `
        mutation ($input: CreateRelationshipTypeInput!) {
          createRelationshipType(input: $input) {
            relationshipType {
              id
            }
            code
            issues {
              code
            }
          }
        }
      `,
      variables: {
        input: {
          namespace: "social",
          key: "exclusive",
          forwardLabel: "exclusive",
          inverseLabel: "exclusive",
          directed: true,
          allowedMultiplicity: "ONE_TO_ONE",
        },
      },
    });
    const create = (targetPersonId: string) =>
      fixture.execute<{
        createRelationship: {
          code: string | null;
          relationship: { id: string } | null;
        };
      }>({
        jar: owner.jar,
        query: /* GraphQL */ `
          mutation ($input: CreateRelationshipInput!) {
            createRelationship(input: $input) {
              relationship {
                id
              }
              code
              issues {
                code
              }
            }
          }
        `,
        variables: {
          input: {
            sourcePersonId: ids[0],
            targetPersonId,
            relationshipTypeId:
              type.body?.data?.createRelationshipType.relationshipType?.id,
          },
        },
      });
    const results = await Promise.all([create(ids[1]!), create(ids[2]!)]);
    expect(
      results.filter(
        (result) => result.body?.data?.createRelationship.relationship,
      ),
    ).toHaveLength(1);
    expect(
      results.filter(
        (result) => result.body?.data?.createRelationship.code === "CONFLICT",
      ),
    ).toHaveLength(1);
    const successAudits = await fixture.database
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.action, "relationship.create"));
    expect(successAudits).toHaveLength(1);
  });

  it("rechecks locked relationship endpoints after a concurrent archive", async () => {
    const owner = await fixture.createActor();
    const source = await fixture.createPerson(owner, {
      displayName: "Race source",
    });
    const target = await fixture.createPerson(owner, {
      displayName: "Race target",
    });
    const sourceId = required(source.body?.data?.createPerson?.person?.id);
    const targetId = required(target.body?.data?.createPerson?.person?.id);
    const type = await fixture.execute<{
      createRelationshipType: { relationshipType: { id: string } | null };
    }>({
      jar: owner.jar,
      query: /* GraphQL */ `
        mutation ($input: CreateRelationshipTypeInput!) {
          createRelationshipType(input: $input) {
            relationshipType {
              id
            }
          }
        }
      `,
      variables: {
        input: {
          namespace: "race",
          key: "locked_endpoint",
          forwardLabel: "knows",
          inverseLabel: "known by",
          directed: true,
        },
      },
    });
    const relationshipTypeId = required(
      type.body?.data?.createRelationshipType.relationshipType?.id,
    );
    let pending: ReturnType<ResearchFixture["execute"]> | undefined;

    await fixture.connection.begin(async (locker) => {
      await locker`SELECT id FROM people WHERE id = ${sourceId}::uuid FOR UPDATE`;
      pending = fixture.execute({
        jar: owner.jar,
        query: /* GraphQL */ `
          mutation ($input: CreateRelationshipInput!) {
            createRelationship(input: $input) {
              relationship {
                id
              }
              code
            }
          }
        `,
        variables: {
          input: {
            sourcePersonId: sourceId,
            targetPersonId: targetId,
            relationshipTypeId,
          },
        },
      });
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const [{ blocked }] = await fixture.connection<[{ blocked: boolean }]>`
          SELECT EXISTS (
            SELECT 1 FROM pg_stat_activity
            WHERE datname = current_database()
              AND pid <> pg_backend_pid()
              AND wait_event_type = 'Lock'
              AND query ILIKE '%people%FOR UPDATE%'
          ) AS blocked
        `;
        if (blocked) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      await locker`
        UPDATE people
        SET status = 'archived', deleted_at = now(), deleted_by = ${owner.principalId}
        WHERE id = ${sourceId}::uuid
      `;
    });

    const result = await required(pending);
    expect(result.body?.errors?.[0]?.extensions?.code).toBe("NOT_FOUND");
    expect(
      await fixture.database
        .select({ id: relationships.id })
        .from(relationships)
        .where(eq(relationships.sourcePersonId, sourceId)),
    ).toEqual([]);
    expect(
      await fixture.database
        .select({ id: auditEvents.id })
        .from(auditEvents)
        .where(eq(auditEvents.action, "relationship.create")),
    ).toEqual([]);
  });

  it("rechecks endpoint grants after locking during relationship creation", async () => {
    const owner = await fixture.createActor();
    const contributor = await fixture.createWorkspaceMember(
      owner,
      "contributor",
    );
    const source = await fixture.createPerson(owner, {
      displayName: "Grant-race source",
      sensitivity: "CONFIDENTIAL",
    });
    const target = await fixture.createPerson(owner, {
      displayName: "Grant-race target",
      sensitivity: "CONFIDENTIAL",
    });
    const sourceId = required(source.body?.data?.createPerson?.person?.id);
    const targetId = required(target.body?.data?.createPerson?.person?.id);
    const type = await fixture.execute<{
      createRelationshipType: { relationshipType: { id: string } | null };
    }>({
      jar: owner.jar,
      query: /* GraphQL */ `
        mutation ($input: CreateRelationshipTypeInput!) {
          createRelationshipType(input: $input) {
            relationshipType {
              id
            }
          }
        }
      `,
      variables: {
        input: {
          namespace: "race",
          key: "revoked_endpoint",
          forwardLabel: "knows",
          inverseLabel: "known by",
          directed: true,
        },
      },
    });
    const relationshipTypeId = required(
      type.body?.data?.createRelationshipType.relationshipType?.id,
    );
    const policyId = newId();
    await fixture.database.insert(accessPolicies).values({
      id: policyId,
      workspaceId: owner.workspaceId,
      name: "Relationship endpoint race",
      sensitivityCeiling: "confidential",
      resourceKinds: ["person"],
      state: "active",
      createdBy: owner.principalId,
      updatedBy: owner.principalId,
    });
    const grantIds = [newId(), newId()];
    await fixture.database.insert(resourceGrants).values(
      [sourceId, targetId].map((resourceId, index) => ({
        id: grantIds[index]!,
        workspaceId: owner.workspaceId,
        policyId,
        memberId: contributor.memberId,
        resourceId,
        resourceKind: "person",
        state: "active" as const,
        createdBy: owner.principalId,
        updatedBy: owner.principalId,
      })),
    );
    let pending: ReturnType<ResearchFixture["execute"]> | undefined;
    await fixture.connection.begin(async (locker) => {
      await locker`SELECT id FROM people WHERE id = ${sourceId}::uuid FOR UPDATE`;
      pending = fixture.execute({
        jar: contributor.jar,
        query: /* GraphQL */ `
          mutation ($input: CreateRelationshipInput!) {
            createRelationship(input: $input) {
              relationship {
                id
              }
              code
            }
          }
        `,
        variables: {
          input: {
            sourcePersonId: sourceId,
            targetPersonId: targetId,
            relationshipTypeId,
          },
        },
      });
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const [{ blocked }] = await fixture.connection<[{ blocked: boolean }]>`
          SELECT EXISTS (
            SELECT 1 FROM pg_stat_activity
            WHERE datname = current_database()
              AND pid <> pg_backend_pid()
              AND wait_event_type = 'Lock'
              AND query ILIKE '%people%for update%'
          ) AS blocked
        `;
        if (blocked) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      await locker`
        UPDATE resource_grants SET state = 'inactive'
        WHERE id = ${grantIds[0]}::uuid
      `;
    });
    const result = await required(pending);
    expect(result.body?.errors?.[0]?.extensions?.code).toBe("NOT_FOUND");
    expect(await fixture.database.select().from(relationships)).toEqual([]);
    expect(
      await fixture.database
        .select({ id: auditEvents.id })
        .from(auditEvents)
        .where(eq(auditEvents.action, "relationship.create")),
    ).toEqual([]);
  });

  it("uses opaque source cursors and rejects malformed pages and real-schema complexity", async () => {
    const owner = await fixture.createActor();
    for (const title of ["Source A", "Source B"]) {
      await fixture.execute({
        jar: owner.jar,
        query: /* GraphQL */ `
          mutation ($input: CreateSourceInput!) {
            createSource(input: $input) {
              source {
                id
              }
            }
          }
        `,
        variables: { input: { kind: "archive", title } },
      });
    }
    const query = /* GraphQL */ `
      query ($first: Int, $after: String) {
        sources(first: $first, after: $after) {
          nodes {
            id
            title
          }
          pageInfo {
            endCursor
            hasNextPage
          }
        }
      }
    `;
    const first = await fixture.execute<{
      sources: {
        nodes: Array<{ id: string }>;
        pageInfo: { endCursor: string; hasNextPage: boolean };
      };
    }>({ jar: owner.jar, query, variables: { first: 1 } });
    const second = await fixture.execute<{
      sources: {
        nodes: Array<{ id: string }>;
        pageInfo: { endCursor: string | null; hasNextPage: boolean };
      };
    }>({
      jar: owner.jar,
      query,
      variables: {
        first: 1,
        after: first.body?.data?.sources.pageInfo.endCursor,
      },
    });
    expect(first.body?.data?.sources.pageInfo.hasNextPage).toBe(true);
    expect(second.body?.data?.sources.nodes[0]?.id).not.toBe(
      first.body?.data?.sources.nodes[0]?.id,
    );

    const malformed = await fixture.execute({
      jar: owner.jar,
      query,
      variables: { first: 1, after: "not-a-cursor" },
    });
    expect(malformed.body?.errors?.[0]?.extensions?.code).toBe(
      "VALIDATION_FAILED",
    );
    const invalidPage = await fixture.execute({
      jar: owner.jar,
      query,
      variables: { first: 0 },
    });
    expect(invalidPage.body?.errors?.[0]?.extensions?.code).toBe(
      "VALIDATION_FAILED",
    );

    await fixture.database.execute(sql`DROP TABLE people CASCADE`);
    const recursiveSelection = await fixture.execute({
      jar: owner.jar,
      query: /* GraphQL */ `
        query {
          people(first: 100) {
            nodes {
              fieldSelections(first: 100) {
                nodes {
                  person {
                    fieldSelections(first: 100) {
                      nodes {
                        id
                      }
                    }
                  }
                }
              }
            }
          }
        }
      `,
    });
    expect(recursiveSelection.body?.errors?.[0]?.extensions?.code).toBe(
      "VALIDATION_FAILED",
    );
    expect(recursiveSelection.body?.errors?.[0]?.message).toBe(
      "Operation exceeds the allowed complexity.",
    );
    const complex = await fixture.execute({
      jar: owner.jar,
      query: /* GraphQL */ `
        query {
          people(first: 100) {
            nodes {
              facts(first: 100) {
                nodes {
                  evidence(first: 100) {
                    nodes {
                      evidenceItem {
                        source {
                          id
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      `,
    });
    expect(complex.body?.errors?.[0]?.extensions?.code).toBe(
      "VALIDATION_FAILED",
    );
    expect(complex.body?.errors?.[0]?.message).toBe(
      "Operation exceeds the allowed complexity.",
    );
  });
});
