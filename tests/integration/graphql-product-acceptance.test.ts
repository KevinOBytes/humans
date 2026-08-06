// @vitest-environment node

import { readFile } from "node:fs/promises";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq, inArray } from "drizzle-orm";

import { newId } from "@/db/id";
import { auditEvents } from "@/db/schema/operations";
import { facts } from "@/db/schema/facts";
import { locationMutationIdempotency } from "@/db/schema/locations";
import {
  AiRunDocument,
  CreateEvidenceItemDocument,
  CreateFactDefinitionDocument,
  CreateFactDocument,
  CreateGraphViewDocument,
  CreatePersonDocument,
  CreateRelationshipDocument,
  CreateRelationshipTypeDocument,
  CreateSourceDocument,
  ArchivePersonDocument,
  EvidenceFilesDocument,
  FactEvidenceDocument,
  GraphPageDocument,
  GraphWorkspaceControlsDocument,
  ImportHistoryDocument,
  LinkFactEvidenceDocument,
  PeopleListDocument,
  PersonContradictoryFactsDocument,
  PersonFactsDocument,
  PersonHeaderDocument,
  PersonRelationshipsDocument,
  SearchWorkbenchSavedQueriesDocument,
  SearchWorkbenchSearchDocument,
  StartAiAnalysisDocument,
  UpdatePersonDocument,
} from "@/graphql/generated/graphql";

import { expectGraphQLError, type OperationResult } from "../support/graphql";
import { ResearchFixture } from "../support/research-fixture";

const liveDescribe = process.env.TEST_DATABASE_URL ? describe : describe.skip;

function dataField<T>(
  result: OperationResult<Record<string, T>>,
  field: string,
): T {
  expect(result.body?.errors).toBeUndefined();
  const value = result.body?.data?.[field];
  if (value == null) throw new Error(`Missing GraphQL field ${field}`);
  return value;
}

liveDescribe("whole-product generated GraphQL acceptance matrix", () => {
  let fixture: ResearchFixture;

  beforeAll(() => {
    fixture = new ResearchFixture();
  });
  beforeEach(async () => fixture.reset());
  afterAll(async () => fixture.close());

  it("replays evidence-create references, converges concurrent callers, and fences expiry, corruption, and tenants", async () => {
    const owner = await fixture.createActor();
    const foreign = await fixture.createActor();
    const sourceFor = async (actor: typeof owner, title: string) => {
      const result = await fixture.execute<{
        createSource: { source: { id: string } };
      }>({
        jar: actor.jar,
        operationName: "CreateSource",
        query: CreateSourceDocument,
        variables: { input: { kind: "archive", title } },
      });
      expect(result.body?.errors).toBeUndefined();
      return result.body?.data?.createSource.source.id ?? "";
    };
    const ownerSourceId = await sourceFor(owner, "Idempotent owner source");
    const input = {
      checksum: `sha256:${"b".repeat(64)}`,
      idempotencyKey: "evidence-create-replay-v1",
      sourceId: ownerSourceId,
    };
    const create = (actor: typeof owner, variables: typeof input) =>
      fixture.execute<{
        createEvidenceItem: { evidenceItem: { id: string } | null };
      }>({
        jar: actor.jar,
        operationName: "CreateEvidenceItem",
        query: CreateEvidenceItemDocument,
        variables: { input: variables },
      });
    const [first, replay] = await Promise.all([
      create(owner, input),
      create(owner, input),
    ]);
    expect(first.body?.errors).toBeUndefined();
    expect(replay.body?.errors).toBeUndefined();
    const firstEvidenceId =
      first.body?.data?.createEvidenceItem.evidenceItem?.id;
    expect(firstEvidenceId).toBeTruthy();
    expect(replay.body?.data?.createEvidenceItem.evidenceItem?.id).toBe(
      firstEvidenceId,
    );
    const claims = await fixture.database
      .select()
      .from(locationMutationIdempotency)
      .where(
        and(
          eq(locationMutationIdempotency.workspaceId, owner.workspaceId),
          eq(locationMutationIdempotency.operation, "evidence.create.graphql"),
        ),
      );
    expect(claims).toHaveLength(1);
    const claim = claims[0];
    expect(claim?.responseReference).toEqual({ evidenceId: firstEvidenceId });

    await fixture.database
      .update(locationMutationIdempotency)
      .set({ responseReference: { evidenceId: "not-a-uuid" } })
      .where(eq(locationMutationIdempotency.id, claim?.id ?? ""));
    await expectGraphQLError(await create(owner, input), "PRECONDITION_FAILED");

    const takeoverInput = {
      ...input,
      idempotencyKey: "evidence-create-expiry-v1",
      checksum: `sha256:${"c".repeat(64)}`,
    };
    const beforeExpiry = await create(owner, takeoverInput);
    const beforeExpiryId =
      beforeExpiry.body?.data?.createEvidenceItem.evidenceItem?.id;
    expect(beforeExpiryId).toBeTruthy();
    const takeoverClaims = await fixture.database
      .select()
      .from(locationMutationIdempotency)
      .where(
        and(
          eq(locationMutationIdempotency.workspaceId, owner.workspaceId),
          eq(locationMutationIdempotency.operation, "evidence.create.graphql"),
        ),
      );
    const takeoverClaim = takeoverClaims.find(
      (row) =>
        (row.responseReference as { evidenceId?: unknown } | null)
          ?.evidenceId === beforeExpiryId,
    );
    await fixture.database
      .update(locationMutationIdempotency)
      .set({ expiresAt: new Date(Date.now() - 1_000) })
      .where(eq(locationMutationIdempotency.id, takeoverClaim?.id ?? ""));
    const takeover = await create(owner, takeoverInput);
    const takeoverId = takeover.body?.data?.createEvidenceItem.evidenceItem?.id;
    expect(takeover.body?.errors).toBeUndefined();
    expect(takeoverId).toBeTruthy();
    expect(takeoverId).not.toBe(beforeExpiryId);

    const foreignSourceId = await sourceFor(
      foreign,
      "Idempotent foreign source",
    );
    const foreignResult = await create(foreign, {
      ...input,
      sourceId: foreignSourceId,
    });
    expect(foreignResult.body?.errors).toBeUndefined();
    const foreignEvidenceId =
      foreignResult.body?.data?.createEvidenceItem.evidenceItem?.id;
    expect(foreignEvidenceId).toBeTruthy();
    expect(foreignEvidenceId).not.toBe(firstEvidenceId);
    expect(JSON.stringify(foreignResult.body)).not.toContain(
      firstEvidenceId ?? "",
    );
  });

  it("executes generated operations for every canonical MVP domain through Yoga", async () => {
    const owner = await fixture.createActor();
    const executed = new Set<string>();
    const run = async <T>(input: {
      name: string;
      query: { toString(): string };
      variables?: Record<string, unknown>;
    }) => {
      executed.add(input.name);
      return fixture.execute<Record<string, T>>({
        jar: owner.jar,
        operationName: input.name,
        query: input.query,
        variables: input.variables,
      });
    };

    const firstPerson = dataField<{
      code: string | null;
      issues: unknown[];
      person: { id: string };
    }>(
      await run({
        name: "CreatePerson",
        query: CreatePersonDocument,
        variables: { input: { displayName: "Matrix Person One" } },
      }),
      "createPerson",
    );
    expect(firstPerson).toMatchObject({ code: null, issues: [] });
    const secondPerson = dataField<{ person: { id: string } }>(
      await run({
        name: "CreatePerson",
        query: CreatePersonDocument,
        variables: { input: { displayName: "Matrix Person Two" } },
      }),
      "createPerson",
    );
    const people = dataField<{ nodes: Array<{ id: string }> }>(
      await run({
        name: "PeopleList",
        query: PeopleListDocument,
        variables: { first: 10 },
      }),
      "people",
    );
    expect(people.nodes.map(({ id }) => id)).toEqual(
      expect.arrayContaining([firstPerson.person.id, secondPerson.person.id]),
    );

    const definition = dataField<{
      code: string | null;
      factDefinition: { id: string };
      issues: unknown[];
    }>(
      await run({
        name: "CreateFactDefinition",
        query: CreateFactDefinitionDocument,
        variables: {
          input: {
            allowedValueType: "TEXT",
            fieldKey: "matrix_fact",
            label: "Matrix fact",
            namespace: "person",
          },
        },
      }),
      "createFactDefinition",
    );
    expect(definition).toMatchObject({ code: null, issues: [] });
    const fact = dataField<{
      code: string | null;
      fact: { id: string };
      issues: unknown[];
    }>(
      await run({
        name: "CreateFact",
        query: CreateFactDocument,
        variables: {
          input: {
            definitionId: definition.factDefinition.id,
            personId: firstPerson.person.id,
            value: { text: "Generated operation evidence" },
          },
        },
      }),
      "createFact",
    );
    expect(fact).toMatchObject({ code: null, issues: [] });
    expect(
      dataField<{ facts: { nodes: Array<{ id: string }> } }>(
        await run({
          name: "PersonFacts",
          query: PersonFactsDocument,
          variables: { first: 10, id: firstPerson.person.id },
        }),
        "person",
      ).facts.nodes,
    ).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: fact.fact.id })]),
    );
    const contradictoryFact = dataField<{
      code: string | null;
      fact: { id: string };
      issues: unknown[];
    }>(
      await run({
        name: "CreateFact",
        query: CreateFactDocument,
        variables: {
          input: {
            definitionId: definition.factDefinition.id,
            personId: firstPerson.person.id,
            value: { text: "Contradictory operation evidence" },
          },
        },
      }),
      "createFact",
    );
    expect(contradictoryFact).toMatchObject({ code: null, issues: [] });
    expect(
      dataField<{
        contradictoryFacts: { nodes: Array<{ id: string }> };
      }>(
        await run({
          name: "PersonContradictoryFacts",
          query: PersonContradictoryFactsDocument,
          variables: { first: 10, id: firstPerson.person.id },
        }),
        "person",
      ).contradictoryFacts.nodes,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: fact.fact.id }),
        expect.objectContaining({ id: contradictoryFact.fact.id }),
      ]),
    );

    const relationshipType = dataField<{
      relationshipType: { id: string };
    }>(
      await run({
        name: "CreateRelationshipType",
        query: CreateRelationshipTypeDocument,
        variables: {
          input: {
            forwardLabel: "knows",
            inverseLabel: "known by",
            key: "matrix_knows",
            namespace: "person",
          },
        },
      }),
      "createRelationshipType",
    );
    const relationship = dataField<{ relationship: { id: string } }>(
      await run({
        name: "CreateRelationship",
        query: CreateRelationshipDocument,
        variables: {
          input: {
            relationshipTypeId: relationshipType.relationshipType.id,
            sourcePersonId: firstPerson.person.id,
            targetPersonId: secondPerson.person.id,
          },
        },
      }),
      "createRelationship",
    );
    expect(
      dataField<{ relationships: { nodes: Array<{ id: string }> } }>(
        await run({
          name: "PersonRelationships",
          query: PersonRelationshipsDocument,
          variables: { first: 10, id: firstPerson.person.id },
        }),
        "person",
      ).relationships.nodes,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: relationship.relationship.id }),
      ]),
    );

    const source = dataField<{ source: { id: string } }>(
      await run({
        name: "CreateSource",
        query: CreateSourceDocument,
        variables: { input: { kind: "archive", title: "Matrix source" } },
      }),
      "createSource",
    );
    const evidence = dataField<{ evidenceItem: { id: string } }>(
      await run({
        name: "CreateEvidenceItem",
        query: CreateEvidenceItemDocument,
        variables: {
          input: {
            checksum: `sha256:${"a".repeat(64)}`,
            sourceId: source.source.id,
          },
        },
      }),
      "createEvidenceItem",
    );
    dataField(
      await run({
        name: "LinkFactEvidence",
        query: LinkFactEvidenceDocument,
        variables: {
          input: {
            evidenceItemId: evidence.evidenceItem.id,
            factId: fact.fact.id,
          },
        },
      }),
      "linkFactEvidence",
    );
    expect(
      dataField<{
        evidence: { nodes: Array<{ evidenceItem: { id: string } }> };
      }>(
        await run({
          name: "FactEvidence",
          query: FactEvidenceDocument,
          variables: { first: 10, id: fact.fact.id },
        }),
        "fact",
      ).evidence.nodes,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          evidenceItem: expect.objectContaining({
            id: evidence.evidenceItem.id,
          }),
        }),
      ]),
    );

    expect(
      dataField<{ nodes: unknown[] }>(
        await run({
          name: "EvidenceFiles",
          query: EvidenceFilesDocument,
          variables: { first: 1 },
        }),
        "files",
      ).nodes,
    ).toEqual([]);
    expect(
      dataField<{ nodes: unknown[] }>(
        await run({
          name: "ImportHistory",
          query: ImportHistoryDocument,
          variables: { first: 1 },
        }),
        "imports",
      ).nodes,
    ).toEqual([]);

    dataField(
      await run({
        name: "SearchWorkbenchSearch",
        query: SearchWorkbenchSearchDocument,
        variables: {
          input: {
            filters: {},
            first: 10,
            kinds: ["PERSON"],
            match: { query: "Matrix", type: "TEXT" },
            version: 1,
          },
        },
      }),
      "search",
    );
    dataField(
      await run({
        name: "SearchWorkbenchSavedQueries",
        query: SearchWorkbenchSavedQueriesDocument,
        variables: { first: 10 },
      }),
      "savedQueries",
    );

    dataField(
      await run({
        name: "GraphPage",
        query: GraphPageDocument,
        variables: {
          filter: { edgeLimit: 10, mode: "WORKSPACE", nodeLimit: 10 },
        },
      }),
      "graph",
    );
    dataField(
      await run({
        name: "CreateGraphView",
        query: CreateGraphViewDocument,
        variables: {
          input: {
            filter: { edgeLimit: 10, mode: "WORKSPACE", nodeLimit: 10 },
            name: "Matrix saved view",
          },
        },
      }),
      "createGraphView",
    );
    dataField(
      await run({
        name: "GraphWorkspaceControls",
        query: GraphWorkspaceControlsDocument,
        variables: { viewsFirst: 10 },
      }),
      "graphViews",
    );

    const aiRun = dataField<{ id: string }>(
      await run({
        name: "StartAiAnalysis",
        query: StartAiAnalysisDocument,
        variables: {
          input: {
            idempotencyKey: `matrix-${newId()}`,
            question: "Summarize this workspace for the acceptance matrix.",
          },
        },
      }),
      "startAiAnalysis",
    );
    expect(
      dataField<{ id: string }>(
        await run({
          name: "AiRun",
          query: AiRunDocument,
          variables: { id: aiRun.id },
        }),
        "aiRun",
      ).id,
    ).toBe(aiRun.id);

    const matrix = JSON.parse(
      await readFile("tests/acceptance/graphql-product-matrix.json", "utf8"),
    ) as {
      domains: Array<{ evidence: string[]; generatedOperations: string[] }>;
    };
    const requiredOperations = [
      ...new Set(
        matrix.domains
          .filter(({ evidence }) =>
            evidence.includes(
              "tests/integration/graphql-product-acceptance.test.ts",
            ),
          )
          .flatMap((entry) => entry.generatedOperations),
      ),
    ].sort();
    const allDeclaredOperations = new Set(
      matrix.domains.flatMap((entry) => entry.generatedOperations),
    );
    expect([...executed]).toEqual(expect.arrayContaining(requiredOperations));
    expect(
      [...executed].every((operation) => allDeclaredOperations.has(operation)),
    ).toBe(true);
  });

  it("enforces strict scalars, tagged input unions, pagination, batching, and stable issues", async () => {
    const owner = await fixture.createActor();

    expectGraphQLError(
      await fixture.execute({
        jar: owner.jar,
        operationName: "PersonHeader",
        query: PersonHeaderDocument,
        variables: { id: "not-a-uuid" },
      }),
      "VALIDATION_FAILED",
    );
    expectGraphQLError(
      await fixture.execute({
        jar: owner.jar,
        operationName: "GraphPage",
        query: GraphPageDocument,
        variables: { filter: { at: "not-a-date-time", mode: "WORKSPACE" } },
      }),
      "VALIDATION_FAILED",
    );
    expectGraphQLError(
      await fixture.execute({
        jar: owner.jar,
        operationName: "SearchWorkbenchSearch",
        query: SearchWorkbenchSearchDocument,
        variables: {
          input: {
            filters: {},
            first: 10,
            kinds: ["PERSON"],
            match: {
              query: "ambiguous",
              type: "TEXT",
              value: "must-not-coexist",
            },
            version: 1,
          },
        },
      }),
      "VALIDATION_FAILED",
    );

    const person = dataField<{ person: { id: string } }>(
      await fixture.execute({
        jar: owner.jar,
        operationName: "CreatePerson",
        query: CreatePersonDocument,
        variables: { input: { displayName: "Union constraint subject" } },
      }),
      "createPerson",
    );
    const definition = dataField<{ factDefinition: { id: string } }>(
      await fixture.execute({
        jar: owner.jar,
        operationName: "CreateFactDefinition",
        query: CreateFactDefinitionDocument,
        variables: {
          input: {
            allowedValueType: "TEXT",
            fieldKey: "union_constraint",
            label: "Union constraint",
            namespace: "person",
          },
        },
      }),
      "createFactDefinition",
    );
    const invalidFact = await fixture.execute<{
      createFact: {
        code: string | null;
        issues: Array<{ code: string; message: string; path: string[] }>;
      };
    }>({
      jar: owner.jar,
      operationName: "CreateFact",
      query: CreateFactDocument,
      variables: {
        input: {
          definitionId: definition.factDefinition.id,
          personId: person.person.id,
          value: { boolean: true, text: "ambiguous" },
        },
      },
    });
    expect(invalidFact.body?.errors).toBeUndefined();
    expect(invalidFact.body?.data?.createFact).toMatchObject({
      code: "VALIDATION_FAILED",
      issues: [
        {
          code: "INVALID_FACT_VALUE",
          message: "The value does not match its definition type.",
          path: ["value"],
        },
      ],
    });

    for (const first of [0, 101]) {
      expectGraphQLError(
        await fixture.execute({
          jar: owner.jar,
          operationName: "PeopleList",
          query: PeopleListDocument,
          variables: { first },
        }),
        "VALIDATION_FAILED",
      );
    }
    expectGraphQLError(
      await fixture.execute({
        jar: owner.jar,
        operationName: "PeopleList",
        query: PeopleListDocument,
        variables: { after: "not-a-cursor", first: 1 },
      }),
      "VALIDATION_FAILED",
    );
    expectGraphQLError(
      await fixture.execute({
        body: JSON.stringify([
          { operationName: "PeopleList", query: PeopleListDocument.toString() },
        ]),
        jar: owner.jar,
      }),
      "VALIDATION_FAILED",
    );

    const invalidPerson = await fixture.execute<{
      createPerson: {
        code: string | null;
        issues: Array<{ code: string; message: string; path: string[] }>;
      };
    }>({
      jar: owner.jar,
      operationName: "CreatePerson",
      query: CreatePersonDocument,
      variables: { input: { displayName: "   " } },
    });
    expect(invalidPerson.body?.errors).toBeUndefined();
    expect(invalidPerson.body?.data?.createPerson).toMatchObject({
      code: "VALIDATION_FAILED",
      issues: [
        {
          code: "INVALID_STRING",
          message: expect.any(String),
          path: ["displayName"],
        },
      ],
    });
    expect(JSON.stringify(invalidPerson.body)).not.toMatch(
      /select |insert |update |delete |postgres/iu,
    );
  });

  it("replays generated createPerson responses without duplicating the person", async () => {
    const owner = await fixture.createActor();
    const input = {
      displayName: "Generated idempotent person",
      idempotencyKey: "generated-person-replay",
    };
    const first = await fixture.execute<{
      createPerson: { code: string | null; person: { id: string } | null };
    }>({
      jar: owner.jar,
      operationName: "CreatePerson",
      query: CreatePersonDocument,
      variables: { input },
    });
    const replay = await fixture.execute<{
      createPerson: { code: string | null; person: { id: string } | null };
    }>({
      jar: owner.jar,
      operationName: "CreatePerson",
      query: CreatePersonDocument,
      variables: { input },
    });
    expect(first.body?.errors).toBeUndefined();
    expect(replay.body?.errors).toBeUndefined();
    expect(first.body?.data?.createPerson).toMatchObject({ code: null });
    expect(replay.body?.data?.createPerson).toMatchObject({ code: null });
    expect(replay.body?.data?.createPerson.person?.id).toBe(
      first.body?.data?.createPerson.person?.id,
    );
  });

  it("replays generated updatePerson and archivePerson responses without duplicate writes", async () => {
    const owner = await fixture.createActor();
    const created = dataField<{ person: { id: string; version: number } }>(
      await fixture.execute({
        jar: owner.jar,
        operationName: "CreatePerson",
        query: CreatePersonDocument,
        variables: {
          input: { displayName: "Generated person mutation subject" },
        },
      }),
      "createPerson",
    );
    const updateInput = {
      id: created.person.id,
      expectedVersion: created.person.version,
      idempotencyKey: "generated-person-update-replay",
      displayName: "Generated person mutation subject, updated",
    };
    const update = () =>
      fixture.execute<{
        updatePerson: {
          code: string | null;
          person: { id: string; version: number } | null;
        };
      }>({
        jar: owner.jar,
        operationName: "UpdatePerson",
        query: UpdatePersonDocument,
        variables: { input: updateInput },
      });
    const [firstUpdate, replayedUpdate] = await Promise.all([
      update(),
      update(),
    ]);
    expect(firstUpdate.body?.errors).toBeUndefined();
    expect(replayedUpdate.body?.errors).toBeUndefined();
    expect(firstUpdate.body?.data?.updatePerson).toMatchObject({
      code: null,
      person: { id: created.person.id, version: created.person.version + 1 },
    });
    expect(replayedUpdate.body?.data?.updatePerson).toMatchObject({
      code: null,
      person: { id: created.person.id, version: created.person.version + 1 },
    });

    const archiveInput = {
      id: created.person.id,
      expectedVersion: created.person.version + 1,
      idempotencyKey: "generated-person-archive-replay",
    };
    const archive = () =>
      fixture.execute<{
        archivePerson: {
          code: string | null;
          person: { id: string; version: number; status: string } | null;
        };
      }>({
        jar: owner.jar,
        operationName: "ArchivePerson",
        query: ArchivePersonDocument,
        variables: { input: archiveInput },
      });
    const [firstArchive, replayedArchive] = await Promise.all([
      archive(),
      archive(),
    ]);
    expect(firstArchive.body?.errors).toBeUndefined();
    expect(replayedArchive.body?.errors).toBeUndefined();
    expect(firstArchive.body?.data?.archivePerson).toMatchObject({
      code: null,
      person: {
        id: created.person.id,
        version: created.person.version + 2,
        status: "ARCHIVED",
      },
    });
    expect(replayedArchive.body?.data?.archivePerson).toMatchObject({
      code: null,
      person: {
        id: created.person.id,
        version: created.person.version + 2,
        status: "ARCHIVED",
      },
    });
    expect(
      await fixture.database
        .select({ id: auditEvents.id })
        .from(auditEvents)
        .where(
          and(
            eq(auditEvents.workspaceId, owner.workspaceId),
            inArray(auditEvents.action, [
              "person.create",
              "person.update",
              "person.archive",
            ]),
          ),
        ),
    ).toHaveLength(3);
  });

  it("covers generated createFact replay, concurrency, expiry, malformed references, and tenant fencing", async () => {
    const owner = await fixture.createActor();
    const person = dataField<{ person: { id: string } }>(
      await fixture.execute({
        jar: owner.jar,
        operationName: "CreatePerson",
        query: CreatePersonDocument,
        variables: { input: { displayName: "Generated fact subject" } },
      }),
      "createPerson",
    );
    const definition = dataField<{
      factDefinition: { id: string };
    }>(
      await fixture.execute({
        jar: owner.jar,
        operationName: "CreateFactDefinition",
        query: CreateFactDefinitionDocument,
        variables: {
          input: {
            allowedValueType: "TEXT",
            fieldKey: "generated_fact_idempotency",
            label: "Generated fact idempotency",
            namespace: "person",
          },
        },
      }),
      "createFactDefinition",
    );
    const input = (idempotencyKey: string, text: string) => ({
      definitionId: definition.factDefinition.id,
      idempotencyKey,
      personId: person.person.id,
      value: { text },
    });
    const create = (idempotencyKey: string, text: string) =>
      fixture.execute<{
        createFact: { code: string | null; fact: { id: string } | null };
      }>({
        jar: owner.jar,
        operationName: "CreateFact",
        query: CreateFactDocument,
        variables: { input: input(idempotencyKey, text) },
      });

    const concurrent = await Promise.all(
      Array.from({ length: 3 }, () =>
        create("generated-fact-concurrent", "concurrent fact"),
      ),
    );
    for (const result of concurrent) {
      expect(result.body?.errors).toBeUndefined();
      expect(result.body?.data?.createFact).toMatchObject({ code: null });
    }
    const concurrentIds = new Set(
      concurrent.map((result) => result.body?.data?.createFact.fact?.id),
    );
    expect(concurrentIds.size).toBe(1);

    const malformedFirst = await create(
      "generated-fact-malformed",
      "malformed reference fact",
    );
    const malformedId = malformedFirst.body?.data?.createFact.fact?.id;
    expect(malformedId).toEqual(expect.any(String));
    const malformedClaims = await fixture.database
      .select()
      .from(locationMutationIdempotency)
      .where(eq(locationMutationIdempotency.workspaceId, owner.workspaceId));
    const malformedClaim = malformedClaims.find(
      (claim) =>
        claim.operation === "fact.create.graphql" &&
        (claim.responseReference as { factId?: unknown } | null)?.factId ===
          malformedId,
    );
    if (!malformedClaim)
      throw new Error("The fact idempotency claim is missing.");
    await fixture.database
      .update(locationMutationIdempotency)
      .set({ responseReference: { factId: ["malformed"] } })
      .where(eq(locationMutationIdempotency.id, malformedClaim.id));
    expectGraphQLError(
      await create("generated-fact-malformed", "malformed reference fact"),
      "VALIDATION_FAILED",
    );

    const expiredFirst = await create(
      "generated-fact-expired",
      "expired reference fact",
    );
    const expiredId = expiredFirst.body?.data?.createFact.fact?.id;
    const expiredClaim = (
      await fixture.database
        .select()
        .from(locationMutationIdempotency)
        .where(eq(locationMutationIdempotency.workspaceId, owner.workspaceId))
    ).find(
      (claim) =>
        claim.operation === "fact.create.graphql" &&
        (claim.responseReference as { factId?: unknown } | null)?.factId ===
          expiredId,
    );
    if (!expiredClaim) throw new Error("The expiring fact claim is missing.");
    await fixture.database
      .update(locationMutationIdempotency)
      .set({ expiresAt: new Date(Date.now() - 1_000) })
      .where(eq(locationMutationIdempotency.id, expiredClaim.id));
    const expiredReplay = await create(
      "generated-fact-expired",
      "expired reference fact",
    );
    expect(expiredReplay.body?.errors).toBeUndefined();
    expect(expiredReplay.body?.data?.createFact.fact?.id).not.toBe(expiredId);

    const foreign = await fixture.createActor();
    const foreignResult = await fixture.execute({
      jar: foreign.jar,
      operationName: "CreateFact",
      query: CreateFactDocument,
      variables: { input: input("generated-fact-foreign", "cross tenant") },
    });
    expectGraphQLError(foreignResult, "NOT_FOUND");

    const persistedFacts = await fixture.database
      .select({ id: facts.id })
      .from(facts)
      .where(eq(facts.workspaceId, owner.workspaceId));
    expect(persistedFacts).toHaveLength(4);
    const persistedAudits = await fixture.database
      .select({ action: auditEvents.action })
      .from(auditEvents)
      .where(eq(auditEvents.workspaceId, owner.workspaceId));
    expect(
      persistedAudits.filter((row) => row.action === "fact.create").length,
    ).toBe(4);
  });

  it("allows owner and administrator production introspection while denying lesser authority", async () => {
    const production = new ResearchFixture({ environment: "production" });
    try {
      await production.reset();
      const owner = await production.createActor();
      const administrator = await production.createWorkspaceMember(
        owner,
        "admin",
      );
      const viewer = await production.createWorkspaceMember(owner, "viewer");
      const readKey = await production.provisionKey(owner, {
        person: ["read"],
      });
      const introspectionKey = await production.provisionKey(owner, {
        graphql: ["introspect"],
      });
      const query = "query ProductSchema { __schema { queryType { name } } }";

      for (const jar of [owner.jar, administrator.jar]) {
        const result = await production.execute({ jar, query });
        expect(result.body?.errors).toBeUndefined();
        expect(result.body?.data).toEqual({
          __schema: { queryType: { name: "Query" } },
        });
      }
      expectGraphQLError(
        await production.execute({ jar: viewer.jar, query }),
        "FORBIDDEN",
      );
      expectGraphQLError(
        await production.execute({ apiKey: readKey.key, origin: null, query }),
        "FORBIDDEN",
      );
      const allowedKey = await production.execute({
        apiKey: introspectionKey.key,
        origin: null,
        query,
      });
      expect(allowedKey.body?.errors).toBeUndefined();
      expect(allowedKey.body?.data).toBeDefined();
    } finally {
      await production.close();
    }
  });
});
