// @vitest-environment node

import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { newId } from "@/db/id";
import {
  evidenceExcerpts,
  evidenceItems,
  notes,
  personAddresses,
  personContactPoints,
  sources,
} from "@/db/schema/evidence";
import { factDefinitions, facts } from "@/db/schema/facts";
import { addresses, contactPoints } from "@/db/schema/locations";
import { auditEvents } from "@/db/schema/operations";
import { people, personIdentifiers, personNames } from "@/db/schema/people";
import { searchDocuments } from "@/db/schema/search";
import { relationshipTypes, relationships } from "@/db/schema/relationships";
import { accessPolicies, resourceGrants } from "@/db/schema/workspaces";
import { prepareProtectedExactV1 } from "@/lib/security/protected-exact";
import { createSearchIndexMaintenance } from "@/modules/search/indexer";
import type { SearchIndexMaintenance } from "@/modules/search/index-maintenance";
import {
  createTask12Metrics,
  type MetricsSink,
} from "@/modules/search/metrics";
import { normalizeSearchInput } from "@/modules/search/normalization";
import { createSearchRepository } from "@/modules/search/repository";

import {
  expectGraphQLError,
  type OperationResult,
  type SessionActor,
} from "../support/graphql";
import { testAdminEnv } from "../support/auth";
import { ResearchFixture } from "../support/research-fixture";

const liveDescribe = process.env.TEST_DATABASE_URL ? describe : describe.skip;

const SEARCH = `query Search($input: SearchInput!) {
  search(input: $input) {
    nodes {
      id
      kind
      title
      rank
      updatedAt
      subjectPersonId
      snippet { text matched }
    }
    pageInfo { hasNextPage endCursor }
  }
}`;

type SearchResult = {
  search: {
    nodes: Array<{
      id: string;
      kind: string;
      rank: number | null;
      title: string;
      snippet: Array<{ text: string; matched: boolean }>;
      subjectPersonId: string | null;
    }>;
    pageInfo: { endCursor: string | null; hasNextPage: boolean };
  };
};

const phone = "+1 (212) 555-0188";
const identifier = { namespace: "Employee.ID", value: "Case Sensitive 88" };

function textInput(
  query: string,
  input: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    version: 1,
    match: { type: "TEXT", query },
    kinds: ["PERSON"],
    filters: {},
    first: 10,
    ...input,
  };
}

async function addGrant(
  fixture: ResearchFixture,
  actor: SessionActor,
  resourceId: string,
): Promise<void> {
  const policyId = newId();
  await fixture.database.insert(accessPolicies).values({
    id: policyId,
    workspaceId: actor.workspaceId,
    name: `Search visibility ${policyId}`,
    sensitivityCeiling: "restricted",
    resourceKinds: ["person"],
    state: "active",
    createdBy: actor.principalId,
    updatedBy: actor.principalId,
  });
  await fixture.database.insert(resourceGrants).values({
    id: newId(),
    workspaceId: actor.workspaceId,
    policyId,
    memberId: actor.memberId,
    resourceId,
    resourceKind: "person",
    createdBy: actor.principalId,
    updatedBy: actor.principalId,
  });
}

async function addProtectedValues(
  fixture: ResearchFixture,
  actor: SessionActor,
  personId: string,
): Promise<void> {
  const preparedPhone = prepareProtectedExactV1({
    blindIndexKey: testAdminEnv.PROTECTED_LOOKUP_HMAC_KEY,
    encryptionKey: testAdminEnv.DATA_ENCRYPTION_KEY,
    lookup: { kind: "PHONE", value: phone },
    workspaceId: actor.workspaceId,
  });
  const contactPointId = newId();
  await fixture.database.insert(contactPoints).values({
    id: contactPointId,
    workspaceId: actor.workspaceId,
    kind: "phone",
    encryptedDisplayValue: preparedPhone.encryptedValue,
    blindIndex: preparedPhone.blindIndex,
    blindIndexVersion: 1,
    sensitivity: "public",
    createdBy: actor.principalId,
    updatedBy: actor.principalId,
  });
  await fixture.database.insert(personContactPoints).values({
    id: newId(),
    workspaceId: actor.workspaceId,
    personId,
    contactPointId,
    usageKind: "mobile",
    createdBy: actor.principalId,
    updatedBy: actor.principalId,
  });

  const preparedIdentifier = prepareProtectedExactV1({
    blindIndexKey: testAdminEnv.PROTECTED_LOOKUP_HMAC_KEY,
    encryptionKey: testAdminEnv.DATA_ENCRYPTION_KEY,
    lookup: { kind: "PERSON_IDENTIFIER", ...identifier },
    workspaceId: actor.workspaceId,
  });
  await fixture.database.insert(personIdentifiers).values({
    id: newId(),
    workspaceId: actor.workspaceId,
    personId,
    namespace: preparedIdentifier.namespace!,
    identifierType: "custom",
    encryptedRawValue: preparedIdentifier.encryptedValue,
    blindIndex: preparedIdentifier.blindIndex,
    blindIndexVersion: 1,
    verificationState: "verified",
    sensitivity: "public",
    createdBy: actor.principalId,
    updatedBy: actor.principalId,
  });
}

liveDescribe("Task 12 GraphQL search", () => {
  let fixture: ResearchFixture;
  let maintenance: SearchIndexMaintenance;
  const metricCalls: unknown[] = [];

  beforeAll(async () => {
    maintenance = createSearchIndexMaintenance({
      metrics: createTask12Metrics({
        increment: (...args) => metricCalls.push(["increment", ...args]),
        observe: (...args) => metricCalls.push(["observe", ...args]),
      } satisfies MetricsSink),
    });
    fixture = new ResearchFixture({
      searchIndexMaintenance: maintenance,
      metrics: createTask12Metrics({
        increment: (...args) => metricCalls.push(["increment", ...args]),
        observe: (...args) => metricCalls.push(["observe", ...args]),
      }),
    });
    await fixture.reset();
  });
  beforeEach(async () => {
    await fixture.reset();
    metricCalls.length = 0;
  });
  afterAll(async () => fixture.close());

  it("searches only the authenticated workspace and returns plain snippet parts", async () => {
    const first = await fixture.createActor();
    const second = await fixture.createActor();
    const visible = await fixture.createPerson(first, {
      displayName: "Needle Visible",
    });
    await fixture.createPerson(second, {
      displayName: "Needle Hidden Hidden Hidden",
    });
    const result = await fixture.execute<SearchResult>({
      jar: first.jar,
      query: SEARCH,
      variables: {
        input: {
          version: 1,
          match: { type: "TEXT", query: "Needle" },
          kinds: ["PERSON"],
          filters: {},
          first: 10,
        },
      },
    });

    expect(result.body?.errors).toBeUndefined();
    expect(result.body?.data?.search.nodes).toEqual([
      expect.objectContaining({
        id: visible.body?.data?.createPerson?.person?.id,
        kind: "PERSON",
        title: "Needle Visible",
        snippet: [
          { text: "Needle", matched: true },
          { text: " Visible", matched: false },
        ],
      }),
    ]);
    expect(result.headers.get("cache-control")).toContain("no-store");
    expect(result.headers.get("x-request-id")).toBeTruthy();
  });

  it("matches the same indexed person with or without query diacritics", async () => {
    const actor = await fixture.createActor();
    const created = await fixture.createPerson(actor, {
      displayName: "José Alvarez",
    });
    const id = created.body?.data?.createPerson?.person?.id;
    for (const query of ["Jose", "José"]) {
      const result = await fixture.execute<SearchResult>({
        jar: actor.jar,
        query: SEARCH,
        variables: { input: textInput(query) },
      });
      expect(result.body?.errors).toBeUndefined();
      expect(result.body?.data?.search.nodes.map((node) => node.id)).toEqual([
        id,
      ]);
    }
  });

  it("matches PostgreSQL quoted, negated, and hyphen lexical contexts", async () => {
    const actor = await fixture.createActor();
    const phrase = await fixture.createPerson(actor, {
      displayName: "a or b phrase",
    });
    const negated = await fixture.createPerson(actor, {
      displayName: "x lexical context",
    });
    await fixture.createPerson(actor, { displayName: "or x excluded" });
    const hyphen = await fixture.createPerson(actor, {
      displayName: "alpha-beta context",
    });
    const vectors = [
      ['"a or b"', phrase.body?.data?.createPerson?.person?.id],
      ["-or x", negated.body?.data?.createPerson?.person?.id],
      ["alpha-beta", hyphen.body?.data?.createPerson?.person?.id],
    ] as const;
    for (const [query, expectedId] of vectors) {
      const result = await fixture.execute<SearchResult>({
        jar: actor.jar,
        query: SEARCH,
        variables: { input: textInput(query) },
      });
      expect(result.body?.errors).toBeUndefined();
      expect(result.body?.data?.search.nodes.map(({ id }) => id)).toEqual([
        expectedId,
      ]);
    }
  });

  it("uses the GIN index in the natural actual-query plan after branch authorization", async () => {
    const actor = await fixture.createActor();
    const generatedAt = new Date("2026-08-03T08:00:00.000Z");
    const rows = Array.from({ length: 25_000 }, (_, index) => ({
      id: newId(),
      displayName:
        index === 24_999
          ? "NaturalGinNeedle target"
          : `Natural planner haystack ${index}`,
    }));
    for (let offset = 0; offset < rows.length; offset += 500) {
      const chunk = rows.slice(offset, offset + 500);
      await fixture.database.insert(people).values(
        chunk.map((row) => ({
          id: row.id,
          workspaceId: actor.workspaceId,
          displayName: row.displayName,
          sensitivity: "public" as const,
          createdAt: generatedAt,
          updatedAt: generatedAt,
          createdBy: actor.principalId,
          updatedBy: actor.principalId,
        })),
      );
      await fixture.database.insert(searchDocuments).values(
        chunk.map((row) => ({
          id: newId(),
          workspaceId: actor.workspaceId,
          resourceKind: "person",
          resourceId: row.id,
          sourceVersion: 1,
          resultKind: "PERSON",
          resultId: row.id,
          subjectPersonId: row.id,
          sensitivity: "public" as const,
          redactedText: row.displayName,
          displayText: row.displayName,
          updatedAt: generatedAt,
        })),
      );
    }
    await fixture.database.execute(sql`ANALYZE ${people}`);
    // Consolidate the GIN pending list as normal VACUUM maintenance would; this
    // does not alter planner settings and keeps the assertion on the real plan.
    await fixture.database.execute(sql`VACUUM (ANALYZE) ${searchDocuments}`);

    let plan: unknown = null;
    const repository = createSearchRepository(
      fixture.database,
      {
        workspaceId: actor.workspaceId,
        actor: {
          type: "user",
          id: actor.userId,
          principalId: actor.principalId,
          sessionId: newId(),
          memberId: actor.memberId,
          role: "owner",
        },
      },
      {
        async explain(statement) {
          const explained = (await fixture.database.execute(sql`
            EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${statement}
          `)) as unknown as Array<{ "QUERY PLAN": unknown }>;
          plan = explained[0]?.["QUERY PLAN"] ?? null;
        },
      },
    );
    const search = normalizeSearchInput({
      version: 1,
      match: { type: "text", query: "NaturalGinNeedle" },
      kinds: ["PERSON"],
      filters: {},
      first: 10,
    });
    if (search.match.type !== "text") throw new Error("Expected text search.");
    const result = await repository.searchText({
      cursor: null,
      search: { ...search, match: search.match },
    });
    expect(result.map(({ id }) => id)).toEqual([rows.at(-1)!.id]);
    const serializedPlan = JSON.stringify(plan);
    expect(serializedPlan).toContain("search_documents_search_vector_gin");
    expect(serializedPlan).toContain("Bitmap Index Scan");
  }, 60_000);

  it("rejects non-exclusive GraphQL match tag fields", async () => {
    const actor = await fixture.createActor();
    for (const match of [
      { type: "TEXT", query: "Needle", value: "must-not-be-accepted" },
      {
        type: "PROTECTED_EXACT",
        protectedKind: "PHONE",
        value: "+12125550188",
        query: "must-not-be-accepted",
      },
      {
        type: "PROTECTED_EXACT",
        protectedKind: "PHONE",
        value: "+12125550188",
        namespace: "must-not-be-accepted",
      },
    ]) {
      expectGraphQLError(
        await fixture.execute({
          jar: actor.jar,
          query: SEARCH,
          variables: {
            input: {
              version: 1,
              match,
              kinds: ["PERSON"],
              filters: {},
              first: 10,
            },
          },
        }),
        "VALIDATION_FAILED",
      );
    }
  });

  it("does not cross-authorize colliding source and evidence-item UUIDs", async () => {
    const actor = await fixture.createActor();
    const collisionId = newId();
    const liveSourceId = newId();
    await fixture.database.insert(sources).values([
      {
        id: collisionId,
        workspaceId: actor.workspaceId,
        kind: "document",
        title: "Deleted collision source",
        sensitivity: "public",
        createdBy: actor.principalId,
        updatedBy: actor.principalId,
        deletedAt: new Date(),
        deletedBy: actor.principalId,
      },
      {
        id: liveSourceId,
        workspaceId: actor.workspaceId,
        kind: "document",
        title: "Live evidence source",
        sensitivity: "public",
        createdBy: actor.principalId,
        updatedBy: actor.principalId,
      },
    ]);
    await fixture.database.insert(evidenceItems).values({
      id: collisionId,
      workspaceId: actor.workspaceId,
      sourceId: liveSourceId,
      checksum: "collision-checksum",
      sensitivity: "public",
      createdBy: actor.principalId,
      updatedBy: actor.principalId,
    });
    await fixture.database.insert(searchDocuments).values({
      id: newId(),
      workspaceId: actor.workspaceId,
      resourceKind: "source",
      resourceId: collisionId,
      sourceVersion: 1,
      resultKind: "EVIDENCE",
      resultId: collisionId,
      sensitivity: "public",
      redactedText: "CollisionNeedle",
      bodyText: "",
      displayText: "CollisionNeedle must remain hidden",
    });

    const result = await fixture.execute<SearchResult>({
      jar: actor.jar,
      query: SEARCH,
      variables: {
        input: textInput("CollisionNeedle", { kinds: ["EVIDENCE"] }),
      },
    });
    expect(result.body?.errors).toBeUndefined();
    expect(result.body?.data?.search.nodes).toEqual([]);
  });

  it("authorizes evidence excerpt and note branches across lifecycle, sensitivity, grants, and API keys", async () => {
    const owner = await fixture.createActor();
    const viewer = await fixture.createWorkspaceMember(owner, "viewer");
    let apiKey = await fixture.provisionKey(owner, {
      search: ["read"],
      evidence: ["read"],
      source: ["read"],
    });
    const seedEvidence = async (input: {
      evidenceSensitivity?: "public" | "confidential";
      excerpt: string;
      note: string;
      noteSensitivity?: "public" | "confidential";
      sourceSensitivity?: "public" | "confidential";
    }) => {
      const sourceId = newId();
      const evidenceItemId = newId();
      const excerptId = newId();
      const noteId = newId();
      await fixture.database.insert(sources).values({
        id: sourceId,
        workspaceId: owner.workspaceId,
        kind: "document",
        title: `Evidence matrix source ${sourceId}`,
        sensitivity: input.sourceSensitivity ?? "public",
        createdBy: owner.principalId,
        updatedBy: owner.principalId,
      });
      await fixture.database.insert(evidenceItems).values({
        id: evidenceItemId,
        workspaceId: owner.workspaceId,
        sourceId,
        checksum: `sha256:${evidenceItemId}`,
        reviewState: "accepted",
        sensitivity: input.evidenceSensitivity ?? "public",
        createdBy: owner.principalId,
        updatedBy: owner.principalId,
      });
      await fixture.database.insert(evidenceExcerpts).values({
        id: excerptId,
        workspaceId: owner.workspaceId,
        evidenceItemId,
        excerpt: input.excerpt,
        checksum: `sha256:${excerptId}`,
        redactionState: "clear",
        createdBy: owner.principalId,
      });
      await fixture.database.insert(notes).values({
        id: noteId,
        workspaceId: owner.workspaceId,
        evidenceItemId,
        plainText: input.note,
        sensitivity: input.noteSensitivity ?? "public",
        createdBy: owner.principalId,
        updatedBy: owner.principalId,
      });
      await maintenance.apply(fixture.database, [
        {
          action: "upsert",
          sourceKind: "evidence_item",
          sourceId: evidenceItemId,
          sourceVersion: 1,
          workspaceId: owner.workspaceId,
        },
      ]);
      return { evidenceItemId, excerptId, noteId, sourceId };
    };
    const sessionSearch = (needle: string, first = 10) =>
      fixture.execute<SearchResult>({
        jar: viewer.jar,
        query: SEARCH,
        variables: {
          input: textInput(needle, { kinds: ["EVIDENCE"], first }),
        },
      });
    const apiSearch = (needle: string, first = 10) =>
      fixture.execute<SearchResult>({
        apiKey: apiKey.key,
        origin: null,
        query: SEARCH,
        variables: {
          input: textInput(needle, { kinds: ["EVIDENCE"], first }),
        },
      });
    const expectIds = (
      result: Awaited<ReturnType<typeof sessionSearch>>,
      ids: readonly string[],
    ) => {
      expect(result.body?.errors).toBeUndefined();
      expect(result.body?.data?.search.nodes.map(({ id }) => id)).toEqual(ids);
    };

    const visible = await seedEvidence({
      excerpt: "PolicyOrderNeedle",
      note: "VisibleNoteBranchNeedle",
    });
    expectIds(await sessionSearch("PolicyOrderNeedle", 1), [
      visible.evidenceItemId,
    ]);
    expectIds(await apiSearch("PolicyOrderNeedle", 1), [
      visible.evidenceItemId,
    ]);
    expectIds(await sessionSearch("VisibleNoteBranchNeedle"), [
      visible.evidenceItemId,
    ]);
    expectIds(await apiSearch("VisibleNoteBranchNeedle"), [
      visible.evidenceItemId,
    ]);

    const unaccepted = await seedEvidence({
      excerpt: "UnacceptedExcerptNeedle",
      note: "UnacceptedNoteNeedle",
    });
    await fixture.database
      .update(evidenceItems)
      .set({ reviewState: "rejected", updatedAt: new Date(Date.now() + 1_000) })
      .where(eq(evidenceItems.id, unaccepted.evidenceItemId));
    for (const needle of ["UnacceptedExcerptNeedle", "UnacceptedNoteNeedle"]) {
      expectIds(await sessionSearch(needle), []);
      expectIds(await apiSearch(needle), []);
    }

    const redacted = await seedEvidence({
      excerpt: "RedactedExcerptNeedle",
      note: "RedactionSiblingNote",
    });
    await fixture.database
      .update(evidenceExcerpts)
      .set({ redactionState: "redacted" })
      .where(eq(evidenceExcerpts.id, redacted.excerptId));
    expectIds(await sessionSearch("RedactedExcerptNeedle"), []);
    expectIds(await apiSearch("RedactedExcerptNeedle"), []);

    const deletedSource = await seedEvidence({
      excerpt: "DeletedSourceExcerptNeedle",
      note: "DeletedSourceNoteNeedle",
    });
    await fixture.database
      .update(sources)
      .set({ deletedAt: new Date(), deletedBy: owner.principalId })
      .where(eq(sources.id, deletedSource.sourceId));
    for (const needle of [
      "DeletedSourceExcerptNeedle",
      "DeletedSourceNoteNeedle",
    ]) {
      expectIds(await sessionSearch(needle), []);
      expectIds(await apiSearch(needle), []);
    }

    const strictSource = await seedEvidence({
      excerpt:
        "PolicyOrderNeedle PolicyOrderNeedle PolicyOrderNeedle PolicyOrderNeedle",
      note: "StrictNoteBranchNeedle",
      noteSensitivity: "confidential",
      sourceSensitivity: "confidential",
    });
    expectIds(await sessionSearch("PolicyOrderNeedle", 1), [
      visible.evidenceItemId,
    ]);
    expectIds(await apiSearch("PolicyOrderNeedle", 1), [
      visible.evidenceItemId,
    ]);
    expectIds(await sessionSearch("StrictNoteBranchNeedle"), []);

    const policyId = newId();
    await fixture.database.insert(accessPolicies).values({
      id: policyId,
      workspaceId: owner.workspaceId,
      name: `Evidence matrix visibility ${policyId}`,
      sensitivityCeiling: "restricted",
      resourceKinds: ["source", "evidenceItem", "note"],
      state: "active",
      createdBy: owner.principalId,
      updatedBy: owner.principalId,
    });
    const grant = (
      resourceKind: "source" | "evidenceItem" | "note",
      resourceId: string,
    ) =>
      fixture.database.insert(resourceGrants).values({
        id: newId(),
        workspaceId: owner.workspaceId,
        policyId,
        memberId: viewer.memberId,
        resourceId,
        resourceKind,
        state: "active",
        createdBy: owner.principalId,
        updatedBy: owner.principalId,
      });
    await grant("source", strictSource.sourceId);
    await grant("evidenceItem", strictSource.evidenceItemId);
    expectIds(await sessionSearch("PolicyOrderNeedle", 1), [
      strictSource.evidenceItemId,
    ]);
    expectIds(await sessionSearch("StrictNoteBranchNeedle"), []);
    await grant("note", strictSource.noteId);
    expectIds(await sessionSearch("StrictNoteBranchNeedle"), [
      strictSource.evidenceItemId,
    ]);
    expectIds(await apiSearch("StrictNoteBranchNeedle"), []);

    const strictEvidence = await seedEvidence({
      evidenceSensitivity: "confidential",
      excerpt: "StrictEvidenceExcerptNeedle",
      note: "StrictEvidenceSiblingNote",
    });
    apiKey = await fixture.provisionKey(owner, {
      search: ["read"],
      evidence: ["read"],
      source: ["read"],
    });
    expectIds(await sessionSearch("StrictEvidenceExcerptNeedle"), []);
    expectIds(await apiSearch("StrictEvidenceExcerptNeedle"), []);
    await grant("evidenceItem", strictEvidence.evidenceItemId);
    expectIds(await sessionSearch("StrictEvidenceExcerptNeedle"), [
      strictEvidence.evidenceItemId,
    ]);
    expectIds(await apiSearch("StrictEvidenceExcerptNeedle"), []);
  });

  it("returns the deterministic highest-ranked authorized contribution for a multi-contribution hit", async () => {
    const actor = await fixture.createActor();
    const person = await fixture.createPerson(actor, {
      displayName: "Needle base",
    });
    const personId = person.body?.data?.createPerson?.person?.id;
    if (!personId) throw new Error("Person fixture failed.");
    const aliasId = newId();
    await fixture.database.insert(personNames).values({
      id: aliasId,
      workspaceId: actor.workspaceId,
      personId,
      kind: "alias",
      fullName: "Needle Needle Needle winning alias",
      sensitivity: "public",
      createdBy: actor.principalId,
      updatedBy: actor.principalId,
    });
    await fixture.database.transaction((transaction) =>
      maintenance.apply(transaction, [
        {
          action: "upsert",
          sourceKind: "person_name",
          sourceId: aliasId,
          sourceVersion: 1,
          workspaceId: actor.workspaceId,
        },
      ]),
    );

    const result = await fixture.execute<SearchResult>({
      jar: actor.jar,
      query: SEARCH,
      variables: { input: textInput("Needle") },
    });

    expect(result.body?.errors).toBeUndefined();
    expect(result.body?.data?.search.nodes).toEqual([
      expect.objectContaining({
        id: personId,
        title: "Needle Needle Needle winning alias",
        snippet: [
          { text: "Needle", matched: true },
          { text: " ", matched: false },
          { text: "Needle", matched: true },
          { text: " ", matched: false },
          { text: "Needle", matched: true },
          { text: " winning alias", matched: false },
        ],
      }),
    ]);
  });

  it("intersects session and API-key scopes before search work", async () => {
    const owner = await fixture.createActor();
    const person = await fixture.createPerson(owner, {
      displayName: "Scoped Search Person",
    });
    const viewer = await fixture.createWorkspaceMember(owner, "viewer");
    const session = await fixture.execute<SearchResult>({
      jar: viewer.jar,
      query: SEARCH,
      variables: { input: textInput("Scoped") },
    });
    expect(session.body?.data?.search.nodes.map(({ id }) => id)).toEqual([
      person.body?.data?.createPerson?.person?.id,
    ]);

    const missingSearch = await fixture.provisionKey(owner, {
      person: ["read"],
    });
    expectGraphQLError(
      await fixture.execute({
        apiKey: missingSearch.key,
        origin: null,
        query: SEARCH,
        variables: { input: textInput("Scoped") },
      }),
      "FORBIDDEN",
    );
    const missingPerson = await fixture.provisionKey(owner, {
      search: ["read"],
    });
    expectGraphQLError(
      await fixture.execute({
        apiKey: missingPerson.key,
        origin: null,
        query: SEARCH,
        variables: { input: textInput("Scoped") },
      }),
      "FORBIDDEN",
    );
    const permitted = await fixture.provisionKey(owner, {
      person: ["read"],
      search: ["read"],
    });
    const allowed = await fixture.execute<SearchResult>({
      apiKey: permitted.key,
      origin: null,
      query: SEARCH,
      variables: { input: textInput("Scoped") },
    });
    expect(allowed.body?.errors).toBeUndefined();
    expect(allowed.body?.data?.search.nodes.map(({ id }) => id)).toEqual([
      person.body?.data?.createPerson?.person?.id,
    ]);
  });

  it("requires every resource read scope encoded by each public result kind", async () => {
    const owner = await fixture.createActor();
    const denied = [
      { kind: "PERSON", permissions: { search: ["read"] } },
      { kind: "ADDRESS", permissions: { search: ["read"] } },
      { kind: "FACT", permissions: { search: ["read"], fact: ["read"] } },
      { kind: "FACT", permissions: { search: ["read"], person: ["read"] } },
      {
        kind: "RELATIONSHIP",
        permissions: { search: ["read"], relationship: ["read"] },
      },
      {
        kind: "RELATIONSHIP",
        permissions: { search: ["read"], person: ["read"] },
      },
      {
        kind: "EVIDENCE",
        permissions: { search: ["read"], evidence: ["read"] },
      },
      { kind: "EVIDENCE", permissions: { search: ["read"], source: ["read"] } },
    ] as const;
    for (const { kind, permissions } of denied) {
      const key = await fixture.provisionKey(owner, permissions);
      expectGraphQLError(
        await fixture.execute({
          apiKey: key.key,
          origin: null,
          query: SEARCH,
          variables: { input: textInput("Scope", { kinds: [kind] }) },
        }),
        "FORBIDDEN",
      );
    }
  });

  it("applies same-workspace grants, sensitivity, lifecycle, and filters before ranking", async () => {
    const actor = await fixture.createActor();
    const visible = await fixture.createPerson(actor, {
      displayName: "Matrix Visible",
      sensitivity: "PUBLIC",
    });
    const internal = await fixture.createPerson(actor, {
      displayName: "Matrix Internal",
      sensitivity: "INTERNAL",
    });
    const granted = await fixture.createPerson(actor, {
      displayName: "Matrix Granted",
      sensitivity: "CONFIDENTIAL",
    });
    await fixture.createPerson(actor, {
      displayName: "Matrix Hidden Hidden Hidden Hidden",
      sensitivity: "RESTRICTED",
    });
    const deleted = await fixture.createPerson(actor, {
      displayName: "Matrix Deleted Deleted Deleted",
      sensitivity: "PUBLIC",
    });
    const grantedId = granted.body?.data?.createPerson?.person?.id;
    const deletedId = deleted.body?.data?.createPerson?.person?.id;
    if (!grantedId || !deletedId) throw new Error("Person fixture failed.");
    await addGrant(fixture, actor, grantedId);
    await fixture.database
      .update(people)
      .set({ deletedAt: new Date() })
      .where(eq(people.id, deletedId));

    const result = await fixture.execute<SearchResult>({
      jar: actor.jar,
      query: SEARCH,
      variables: { input: textInput("Matrix") },
    });
    expect(result.body?.errors).toBeUndefined();
    expect(
      new Set(result.body?.data?.search.nodes.map(({ title }) => title)),
    ).toEqual(new Set(["Matrix Visible", "Matrix Internal", "Matrix Granted"]));

    const visibleId = visible.body?.data?.createPerson?.person?.id;
    const internalId = internal.body?.data?.createPerson?.person?.id;
    const filtered = await fixture.execute<SearchResult>({
      jar: actor.jar,
      query: SEARCH,
      variables: {
        input: textInput("Matrix", {
          filters: {
            personIds: [visibleId, internalId],
            sensitivities: ["PUBLIC"],
          },
        }),
      },
    });
    expect(filtered.body?.errors).toBeUndefined();
    expect(filtered.body?.data?.search.nodes.map(({ id }) => id)).toEqual([
      visibleId,
    ]);
  });

  it("authorizes stricter contribution sensitivity before match, rank, and snippets", async () => {
    const actor = await fixture.createActor();
    const anchor = await fixture.createPerson(actor, {
      displayName: "Contribution Anchor",
      sensitivity: "INTERNAL",
    });
    const visible = await fixture.createPerson(actor, {
      displayName: "ContributionSecret visible",
      sensitivity: "PUBLIC",
    });
    const anchorId = anchor.body?.data?.createPerson?.person?.id;
    const visibleId = visible.body?.data?.createPerson?.person?.id;
    if (!anchorId || !visibleId) throw new Error("Person fixture failed.");
    const nameId = newId();
    await fixture.database.insert(personNames).values({
      id: nameId,
      workspaceId: actor.workspaceId,
      personId: anchorId,
      kind: "alias",
      fullName: "ContributionSecret ContributionSecret ContributionSecret",
      sensitivity: "restricted",
      createdBy: actor.principalId,
      updatedBy: actor.principalId,
    });
    await fixture.database.transaction((transaction) =>
      maintenance.apply(transaction, [
        {
          action: "upsert",
          sourceKind: "person_name",
          sourceId: nameId,
          sourceVersion: 1,
          workspaceId: actor.workspaceId,
        },
      ]),
    );
    const hidden = await fixture.execute<SearchResult>({
      jar: actor.jar,
      query: SEARCH,
      variables: { input: textInput("ContributionSecret", { first: 1 }) },
    });
    expect(hidden.body?.errors).toBeUndefined();
    expect(hidden.body?.data?.search.nodes.map(({ id }) => id)).toEqual([
      visibleId,
    ]);
    expect(hidden.body?.data?.search.pageInfo).toEqual({
      endCursor: null,
      hasNextPage: false,
    });
    expect(JSON.stringify(hidden.body)).not.toContain("Anchor");

    await addGrant(fixture, actor, anchorId);
    const granted = await fixture.execute<SearchResult>({
      jar: actor.jar,
      query: SEARCH,
      variables: { input: textInput("ContributionSecret") },
    });
    expect(granted.body?.errors).toBeUndefined();
    expect(
      new Set(granted.body?.data?.search.nodes.map(({ id }) => id)),
    ).toEqual(new Set([anchorId, visibleId]));
  });

  it("excludes deleted address results before FTS", async () => {
    const actor = await fixture.createActor();
    const person = await fixture.createPerson(actor, {
      displayName: "Address Owner",
      sensitivity: "PUBLIC",
    });
    const personId = person.body?.data?.createPerson?.person?.id;
    if (!personId) throw new Error("Person fixture failed.");
    const nameId = newId();
    await fixture.database.insert(personNames).values({
      id: nameId,
      workspaceId: actor.workspaceId,
      personId,
      kind: "alias",
      fullName: "DeletedAddressNeedle source",
      sensitivity: "public",
      createdBy: actor.principalId,
      updatedBy: actor.principalId,
    });
    const addressId = newId();
    await fixture.database.insert(addresses).values({
      id: addressId,
      workspaceId: actor.workspaceId,
      line1: "12 DeletedAddressNeedle Way",
      locality: "DeletedAddressNeedle locality",
      normalizedHash: "a1".repeat(32),
      sensitivity: "public",
      createdBy: actor.principalId,
      updatedBy: actor.principalId,
    });
    const personAddressId = newId();
    await fixture.database.insert(personAddresses).values({
      id: personAddressId,
      workspaceId: actor.workspaceId,
      personId,
      addressId,
      addressKind: "home",
      createdBy: actor.principalId,
      updatedBy: actor.principalId,
    });
    await fixture.database.insert(searchDocuments).values({
      id: newId(),
      workspaceId: actor.workspaceId,
      resourceKind: "person_address",
      resourceId: personAddressId,
      sourceVersion: 1,
      resultKind: "ADDRESS",
      resultId: addressId,
      subjectPersonId: personId,
      sensitivity: "public",
      redactedText: "DeletedAddressNeedle address",
      bodyText: "",
      displayText: "12 DeletedAddressNeedle Way",
    });
    const before = await fixture.execute<SearchResult>({
      jar: actor.jar,
      query: SEARCH,
      variables: {
        input: textInput("DeletedAddressNeedle", { kinds: ["ADDRESS"] }),
      },
    });
    expect(before.body?.data?.search.nodes.map(({ id }) => id)).toEqual([
      addressId,
    ]);
    await fixture.database
      .update(addresses)
      .set({ deletedAt: new Date() })
      .where(eq(addresses.id, addressId));
    const after = await fixture.execute<SearchResult>({
      jar: actor.jar,
      query: SEARCH,
      variables: {
        input: textInput("DeletedAddressNeedle", { kinds: ["ADDRESS"] }),
      },
    });
    expect(after.body?.errors).toBeUndefined();
    expect(after.body?.data?.search.nodes).toEqual([]);
  });

  it("fails closed across address and association changes until the exact association is refreshed", async () => {
    const actor = await fixture.createActor();
    const foreign = await fixture.createActor();
    const person = await fixture.createPerson(actor, {
      displayName: "Locality Owner",
      sensitivity: "PUBLIC",
    });
    const foreignPerson = await fixture.createPerson(foreign, {
      displayName: "Foreign Locality Owner",
      sensitivity: "PUBLIC",
    });
    const personId = person.body?.data?.createPerson?.person?.id;
    const foreignPersonId = foreignPerson.body?.data?.createPerson?.person?.id;
    if (!personId || !foreignPersonId)
      throw new Error("Person fixture failed.");
    const addressId = newId();
    const associationId = newId();
    await fixture.database.insert(addresses).values({
      id: addressId,
      workspaceId: actor.workspaceId,
      line1: "Do Not Search Street",
      locality: "LifecycleLocalityOne",
      region: "LifecycleRegion",
      postalCode: "02139",
      countryCode: "US",
      normalizedHash: "a2".repeat(32),
      sensitivity: "public",
      createdBy: actor.principalId,
      updatedBy: actor.principalId,
    });
    await fixture.database.insert(personAddresses).values({
      id: associationId,
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
        sourceId: associationId,
        sourceVersion: 1,
        workspaceId: actor.workspaceId,
      },
    ]);

    const searchAddress = (query: string) =>
      fixture.execute<SearchResult>({
        jar: actor.jar,
        query: SEARCH,
        variables: {
          input: textInput(query, { kinds: ["ADDRESS"] }),
        },
      });
    const initialAddress = await searchAddress("LifecycleLocalityOne");
    expect(initialAddress.body?.data?.search.nodes.map(({ id }) => id)).toEqual(
      [addressId],
    );
    expect(initialAddress.body?.data?.search.nodes[0]?.subjectPersonId).toBe(
      personId,
    );
    expect(
      (await searchAddress("Search Street")).body?.data?.search.nodes,
    ).toEqual([]);

    const addressChangedAt = new Date(Date.now() + 1_000);
    await fixture.database
      .update(addresses)
      .set({
        locality: "LifecycleLocalityTwo",
        updatedAt: addressChangedAt,
        version: 2,
      })
      .where(eq(addresses.id, addressId));
    expect(
      (await searchAddress("LifecycleLocalityOne")).body?.data?.search.nodes,
    ).toEqual([]);
    await maintenance.apply(fixture.database, [
      {
        action: "upsert",
        sourceKind: "person_address",
        sourceId: associationId,
        sourceVersion: 1,
        workspaceId: actor.workspaceId,
      },
    ]);
    expect(
      (
        await searchAddress("LifecycleLocalityTwo")
      ).body?.data?.search.nodes.map(({ id }) => id),
    ).toEqual([addressId]);

    const linkChangedAt = new Date(addressChangedAt.getTime() + 1_000);
    await fixture.database
      .update(personAddresses)
      .set({
        addressKind: "former_home",
        updatedAt: linkChangedAt,
        version: 2,
      })
      .where(eq(personAddresses.id, associationId));
    expect(
      (await searchAddress("LifecycleLocalityTwo")).body?.data?.search.nodes,
    ).toEqual([]);
    await maintenance.apply(fixture.database, [
      {
        action: "upsert",
        sourceKind: "person_address",
        sourceId: associationId,
        sourceVersion: 2,
        workspaceId: actor.workspaceId,
      },
    ]);
    expect(
      (
        await searchAddress("LifecycleLocalityTwo")
      ).body?.data?.search.nodes.map(({ id }) => id),
    ).toEqual([addressId]);

    const foreignAddressId = newId();
    const foreignAssociationId = newId();
    await fixture.database.insert(addresses).values({
      id: foreignAddressId,
      workspaceId: foreign.workspaceId,
      line1: "Foreign Street",
      locality: "ForeignCollisionLocality",
      normalizedHash: "a3".repeat(32),
      sensitivity: "public",
      createdBy: foreign.principalId,
      updatedBy: foreign.principalId,
    });
    await fixture.database.insert(personAddresses).values({
      id: foreignAssociationId,
      workspaceId: foreign.workspaceId,
      personId: foreignPersonId,
      addressId: foreignAddressId,
      addressKind: "home",
      createdBy: foreign.principalId,
      updatedBy: foreign.principalId,
    });
    await fixture.database.insert(searchDocuments).values({
      id: newId(),
      workspaceId: actor.workspaceId,
      resourceKind: "person_address",
      resourceId: foreignAssociationId,
      sourceVersion: 1,
      resultKind: "ADDRESS",
      resultId: addressId,
      subjectPersonId: personId,
      sensitivity: "public",
      redactedText: "ForeignCollisionNeedle",
      displayText: "ForeignCollisionNeedle",
    });
    expect(
      (await searchAddress("ForeignCollisionNeedle")).body?.data?.search.nodes,
    ).toEqual([]);

    await fixture.database
      .update(personAddresses)
      .set({ deletedAt: new Date(linkChangedAt.getTime() + 1_000) })
      .where(eq(personAddresses.id, associationId));
    expect(
      (await searchAddress("LifecycleLocalityTwo")).body?.data?.search.nodes,
    ).toEqual([]);
  });

  it("paginates tied ranks and timestamps without duplicates and rejects cursor reuse", async () => {
    const actor = await fixture.createActor();
    const ids: string[] = [];
    for (const suffix of ["C", "A", "B"]) {
      const result = await fixture.createPerson(actor, {
        displayName: `Exact Tie ${suffix}`,
      });
      const id = result.body?.data?.createPerson?.person?.id;
      if (!id) throw new Error("Person fixture failed.");
      ids.push(id);
    }
    const tiedAt = new Date("2026-08-03T06:00:00.000Z");
    await fixture.database
      .update(people)
      .set({ updatedAt: tiedAt })
      .where(eq(people.workspaceId, actor.workspaceId));
    await fixture.database
      .update(searchDocuments)
      .set({ updatedAt: tiedAt })
      .where(eq(searchDocuments.workspaceId, actor.workspaceId));

    const seen: string[] = [];
    let after: string | null = null;
    let firstCursor: string | null = null;
    do {
      const page: OperationResult<SearchResult> =
        await fixture.execute<SearchResult>({
          jar: actor.jar,
          query: SEARCH,
          variables: {
            input: textInput("Exact Tie", { after, first: 1 }),
          },
        });
      expect(
        page.body?.errors,
        JSON.stringify(fixture.capturedLogs),
      ).toBeUndefined();
      seen.push(...(page.body?.data?.search.nodes.map(({ id }) => id) ?? []));
      after = page.body?.data?.search.pageInfo.endCursor ?? null;
      firstCursor ??= after;
    } while (after);
    expect(seen).toEqual([...ids].sort());
    expect(new Set(seen)).toHaveLength(3);
    if (!firstCursor) throw new Error("Expected a cursor.");
    expectGraphQLError(
      await fixture.execute({
        jar: actor.jar,
        query: SEARCH,
        variables: {
          input: textInput("Different query", { after: firstCursor, first: 1 }),
        },
      }),
      "VALIDATION_FAILED",
    );
    expectGraphQLError(
      await fixture.execute({
        jar: actor.jar,
        query: SEARCH,
        variables: {
          input: textInput("Exact Tie", {
            after: `${firstCursor.slice(0, -1)}${firstCursor.endsWith("0") ? "1" : "0"}`,
            first: 1,
          }),
        },
      }),
      "VALIDATION_FAILED",
    );
  });

  it("applies fact, relationship, source, state, and temporal filters in authorized SQL", async () => {
    const actor = await fixture.createActor();
    const sourcePerson = await fixture.createPerson(actor, {
      displayName: "Filter Source Person",
      sensitivity: "PUBLIC",
    });
    const targetPerson = await fixture.createPerson(actor, {
      displayName: "Filter Target Person",
      sensitivity: "PUBLIC",
    });
    const personId = sourcePerson.body?.data?.createPerson?.person?.id;
    const targetId = targetPerson.body?.data?.createPerson?.person?.id;
    if (!personId || !targetId) throw new Error("Person fixture failed.");
    const definitionId = newId();
    const otherDefinitionId = newId();
    await fixture.database.insert(factDefinitions).values([
      {
        id: definitionId,
        workspaceId: actor.workspaceId,
        namespace: "task12",
        fieldKey: "selected",
        label: "FilterNeedle selected fact",
        allowedValueType: "text",
        searchable: true,
        state: "active",
        createdBy: actor.principalId,
        updatedBy: actor.principalId,
      },
      {
        id: otherDefinitionId,
        workspaceId: actor.workspaceId,
        namespace: "task12",
        fieldKey: "excluded",
        label: "FilterNeedle excluded fact",
        allowedValueType: "text",
        searchable: true,
        state: "active",
        createdBy: actor.principalId,
        updatedBy: actor.principalId,
      },
    ]);
    const factId = newId();
    const otherFactId = newId();
    await fixture.database.insert(facts).values([
      {
        id: factId,
        workspaceId: actor.workspaceId,
        personId,
        factDefinitionId: definitionId,
        namespace: "task12",
        fieldKey: "selected",
        label: "FilterNeedle fact",
        valueType: "text",
        valueText: "FilterNeedle selected",
        normalizedSearchValue: "FilterNeedle selected",
        state: "asserted",
        sensitivity: "public",
        validEarliestAt: new Date("2026-01-01T00:00:00.000Z"),
        validLatestAt: new Date("2026-12-31T23:59:59.000Z"),
        createdBy: actor.principalId,
        updatedBy: actor.principalId,
      },
      {
        id: otherFactId,
        workspaceId: actor.workspaceId,
        personId,
        factDefinitionId: otherDefinitionId,
        namespace: "task12",
        fieldKey: "excluded",
        label: "FilterNeedle other fact",
        valueType: "text",
        valueText: "FilterNeedle excluded",
        normalizedSearchValue: "FilterNeedle excluded",
        state: "disputed",
        sensitivity: "public",
        validEarliestAt: new Date("2024-01-01T00:00:00.000Z"),
        validLatestAt: new Date("2024-12-31T23:59:59.000Z"),
        createdBy: actor.principalId,
        updatedBy: actor.principalId,
      },
    ]);

    const relationshipTypeId = newId();
    const otherRelationshipTypeId = newId();
    await fixture.database.insert(relationshipTypes).values([
      {
        id: relationshipTypeId,
        workspaceId: actor.workspaceId,
        key: `selected-${newId()}`,
        forwardLabel: "FilterNeedle linked",
        inverseLabel: "FilterNeedle linked by",
        createdBy: actor.principalId,
        updatedBy: actor.principalId,
      },
      {
        id: otherRelationshipTypeId,
        workspaceId: actor.workspaceId,
        key: `excluded-${newId()}`,
        forwardLabel: "FilterNeedle excluded",
        inverseLabel: "FilterNeedle excluded by",
        createdBy: actor.principalId,
        updatedBy: actor.principalId,
      },
    ]);
    const relationshipId = newId();
    const otherRelationshipId = newId();
    await fixture.database.insert(relationships).values([
      {
        id: relationshipId,
        workspaceId: actor.workspaceId,
        sourcePersonId: personId,
        targetPersonId: targetId,
        relationshipTypeId,
        state: "asserted",
        sensitivity: "public",
        validFrom: new Date("2026-01-01T00:00:00.000Z"),
        validUntil: new Date("2026-12-31T23:59:59.000Z"),
        createdBy: actor.principalId,
        updatedBy: actor.principalId,
      },
      {
        id: otherRelationshipId,
        workspaceId: actor.workspaceId,
        sourcePersonId: personId,
        targetPersonId: targetId,
        relationshipTypeId: otherRelationshipTypeId,
        state: "inactive",
        sensitivity: "public",
        validFrom: new Date("2024-01-01T00:00:00.000Z"),
        validUntil: new Date("2024-12-31T23:59:59.000Z"),
        createdBy: actor.principalId,
        updatedBy: actor.principalId,
      },
    ]);
    const sourceId = newId();
    const otherSourceId = newId();
    await fixture.database.insert(sources).values([
      {
        id: sourceId,
        workspaceId: actor.workspaceId,
        kind: "document",
        title: "FilterNeedle source",
        sensitivity: "public",
        createdBy: actor.principalId,
        updatedBy: actor.principalId,
      },
      {
        id: otherSourceId,
        workspaceId: actor.workspaceId,
        kind: "document",
        title: "FilterNeedle other source",
        sensitivity: "public",
        createdBy: actor.principalId,
        updatedBy: actor.principalId,
      },
    ]);
    await fixture.database.transaction((transaction) =>
      maintenance.apply(transaction, [
        {
          action: "upsert",
          sourceKind: "fact",
          sourceId: factId,
          sourceVersion: 1,
          workspaceId: actor.workspaceId,
        },
        {
          action: "upsert",
          sourceKind: "fact",
          sourceId: otherFactId,
          sourceVersion: 1,
          workspaceId: actor.workspaceId,
        },
        {
          action: "upsert",
          sourceKind: "relationship",
          sourceId: relationshipId,
          sourceVersion: 1,
          workspaceId: actor.workspaceId,
        },
        {
          action: "upsert",
          sourceKind: "relationship",
          sourceId: otherRelationshipId,
          sourceVersion: 1,
          workspaceId: actor.workspaceId,
        },
        {
          action: "upsert",
          sourceKind: "source",
          sourceId,
          sourceVersion: 1,
          workspaceId: actor.workspaceId,
        },
        {
          action: "upsert",
          sourceKind: "source",
          sourceId: otherSourceId,
          sourceVersion: 1,
          workspaceId: actor.workspaceId,
        },
      ]),
    );

    const filtered = await fixture.execute<SearchResult>({
      jar: actor.jar,
      query: SEARCH,
      variables: {
        input: textInput("FilterNeedle", {
          kinds: ["FACT", "RELATIONSHIP", "EVIDENCE"],
          filters: {
            personIds: [personId],
            factDefinitionIds: [definitionId],
            factStates: ["asserted"],
            relationshipTypeIds: [relationshipTypeId],
            relationshipStates: ["asserted"],
            sourceIds: [sourceId],
            from: "2026-06-01T00:00:00.000Z",
            until: "2026-06-30T23:59:59.000Z",
          },
        }),
      },
    });
    expect(filtered.body?.errors).toBeUndefined();
    expect(
      new Set(filtered.body?.data?.search.nodes.map(({ id }) => id)),
    ).toEqual(new Set([factId, relationshipId, sourceId]));
    expect(
      filtered.body?.data?.search.nodes.find(({ id }) => id === factId)
        ?.subjectPersonId,
    ).toBe(personId);

    const outsideTime = await fixture.execute<SearchResult>({
      jar: actor.jar,
      query: SEARCH,
      variables: {
        input: textInput("FilterNeedle", {
          kinds: ["FACT", "RELATIONSHIP"],
          filters: { at: "2030-01-01T00:00:00.000Z" },
        }),
      },
    });
    expect(outsideTime.body?.errors).toBeUndefined();
    expect(outsideTime.body?.data?.search.nodes).toEqual([]);
  });

  it("supports protected phone and identifier exact lookup with purpose-bound opaque pagination", async () => {
    const actor = await fixture.createActor();
    const ids: string[] = [];
    for (const suffix of ["One", "Two"]) {
      const result = await fixture.createPerson(actor, {
        displayName: `Protected ${suffix}`,
        sensitivity: "PUBLIC",
      });
      const id = result.body?.data?.createPerson?.person?.id;
      if (!id) throw new Error("Person fixture failed.");
      ids.push(id);
      await addProtectedValues(fixture, actor, id);
    }
    const protectedInput = (
      match: Record<string, unknown>,
      after?: string,
    ) => ({
      version: 1,
      match: { type: "PROTECTED_EXACT", ...match },
      kinds: ["PERSON"],
      filters: {},
      first: 1,
      ...(after ? { after } : {}),
    });
    const first = await fixture.execute<SearchResult>({
      jar: actor.jar,
      query: SEARCH,
      variables: {
        input: protectedInput({ protectedKind: "PHONE", value: phone }),
      },
    });
    expect(first.body?.errors).toBeUndefined();
    const cursor = first.body?.data?.search.pageInfo.endCursor;
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+\.[0-9a-f]{64}$/u);
    expect(cursor).not.toContain(phone);
    const second = await fixture.execute<SearchResult>({
      jar: actor.jar,
      query: SEARCH,
      variables: {
        input: protectedInput(
          { protectedKind: "PHONE", value: phone },
          cursor ?? undefined,
        ),
      },
    });
    expect([
      ...(first.body?.data?.search.nodes.map(({ id }) => id) ?? []),
      ...(second.body?.data?.search.nodes.map(({ id }) => id) ?? []),
    ]).toEqual([...ids].sort());

    const identifierResult = await fixture.execute<SearchResult>({
      jar: actor.jar,
      query: SEARCH,
      variables: {
        input: protectedInput({
          protectedKind: "PERSON_IDENTIFIER",
          namespace: identifier.namespace,
          value: identifier.value,
        }),
      },
    });
    expect(identifierResult.body?.errors).toBeUndefined();
    expect(identifierResult.body?.data?.search.nodes).toHaveLength(1);
    for (const malformed of [
      { protectedKind: "PHONE", value: "not-a-phone" },
      {
        protectedKind: "PERSON_IDENTIFIER",
        namespace: "Bad Namespace!",
        value: "x",
      },
    ])
      expectGraphQLError(
        await fixture.execute({
          jar: actor.jar,
          query: SEARCH,
          variables: { input: protectedInput(malformed) },
        }),
        "VALIDATION_FAILED",
      );

    const permittedKey = await fixture.provisionKey(actor, {
      search: ["read"],
      person: ["read"],
    });
    const keyResult = await fixture.execute<SearchResult>({
      apiKey: permittedKey.key,
      origin: null,
      query: SEARCH,
      variables: {
        input: protectedInput({ protectedKind: "PHONE", value: phone }),
      },
    });
    expect(keyResult.body?.errors).toBeUndefined();
    expect(keyResult.body?.data?.search.nodes).toHaveLength(1);
    expect(keyResult.body?.data?.search.nodes[0]?.subjectPersonId).toBe(
      keyResult.body?.data?.search.nodes[0]?.id,
    );
    const missingPermissionVectors: Record<string, readonly string[]>[] = [
      { search: ["read"] },
      { person: ["read"] },
    ];
    for (const permissions of missingPermissionVectors) {
      const missingScope = await fixture.provisionKey(actor, permissions);
      expectGraphQLError(
        await fixture.execute({
          apiKey: missingScope.key,
          origin: null,
          query: SEARCH,
          variables: {
            input: protectedInput({ protectedKind: "PHONE", value: phone }),
          },
        }),
        "FORBIDDEN",
      );
    }

    const hidden = await fixture.createPerson(actor, {
      displayName: "Protected hidden",
      sensitivity: "CONFIDENTIAL",
    });
    const hiddenId = hidden.body?.data?.createPerson?.person?.id;
    if (!hiddenId) throw new Error("Person fixture failed.");
    const hiddenPhone = "+1 212 555 0176";
    const hiddenPrepared = prepareProtectedExactV1({
      blindIndexKey: testAdminEnv.PROTECTED_LOOKUP_HMAC_KEY,
      encryptionKey: testAdminEnv.DATA_ENCRYPTION_KEY,
      lookup: { kind: "PHONE", value: hiddenPhone },
      workspaceId: actor.workspaceId,
    });
    const hiddenContactId = newId();
    await fixture.database.insert(contactPoints).values({
      id: hiddenContactId,
      workspaceId: actor.workspaceId,
      kind: "phone",
      encryptedDisplayValue: hiddenPrepared.encryptedValue,
      blindIndex: hiddenPrepared.blindIndex,
      blindIndexVersion: 1,
      sensitivity: "confidential",
      createdBy: actor.principalId,
      updatedBy: actor.principalId,
    });
    await fixture.database.insert(personContactPoints).values({
      id: newId(),
      workspaceId: actor.workspaceId,
      personId: hiddenId,
      contactPointId: hiddenContactId,
      usageKind: "mobile",
      createdBy: actor.principalId,
      updatedBy: actor.principalId,
    });
    const hiddenResult = await fixture.execute<SearchResult>({
      apiKey: permittedKey.key,
      origin: null,
      query: SEARCH,
      variables: {
        input: protectedInput({ protectedKind: "PHONE", value: hiddenPhone }),
      },
    });
    expect(hiddenResult.body?.errors).toBeUndefined();
    expect(hiddenResult.body?.data?.search.nodes).toEqual([]);
    expectGraphQLError(
      await fixture.execute({
        jar: actor.jar,
        query: SEARCH,
        variables: {
          input: protectedInput(
            {
              protectedKind: "PERSON_IDENTIFIER",
              namespace: identifier.namespace,
              value: identifier.value,
            },
            cursor ?? undefined,
          ),
        },
      }),
      "VALIDATION_FAILED",
    );

    const audits = await fixture.database
      .select({ redactedDiff: auditEvents.redactedDiff })
      .from(auditEvents)
      .where(eq(auditEvents.action, "search.execute"));
    const diagnostics = JSON.stringify({
      audits,
      logs: fixture.capturedLogs,
      metrics: metricCalls,
    });
    expect(diagnostics).not.toContain(phone);
    expect(diagnostics).not.toContain(identifier.value);
    expect(diagnostics).not.toContain(actor.workspaceId);
    expect(diagnostics).not.toContain(actor.principalId);
    expect(metricCalls.length).toBeGreaterThan(0);
  });
});
