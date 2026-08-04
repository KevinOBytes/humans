// @vitest-environment node

import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { queryRuns, savedQueries } from "@/db/schema/search";
import { workspacePrincipals } from "@/db/schema/principals";
import { newId } from "@/db/id";
import { people } from "@/db/schema/people";
import { auditEvents } from "@/db/schema/operations";
import { createSearchIndexMaintenance } from "@/modules/search/indexer";
import {
  createTask12Metrics,
  disabledMetricsSink,
} from "@/modules/search/metrics";

import { expectGraphQLError } from "../support/graphql";
import { ResearchFixture } from "../support/research-fixture";

const liveDescribe = process.env.TEST_DATABASE_URL ? describe : describe.skip;

const CREATE = `mutation CreateSavedQuery($input: CreateSavedQueryInput!) {
  createSavedQuery(input: $input) { id name sharing version queryAst }
}`;
const LIST = `query SavedQueries($first: Int, $after: String) {
  savedQueries(first: $first, after: $after) {
    nodes { id name sharing version ownerPrincipalId queryAst }
    pageInfo { hasNextPage endCursor }
  }
}`;
const READ = `query SavedQuery($id: UUID!) {
  savedQuery(id: $id) { id queryAst }
}`;
const UPDATE = `mutation UpdateSavedQuery($input: UpdateSavedQueryInput!) {
  updateSavedQuery(input: $input) { id name sharing version queryAst }
}`;
const ARCHIVE = `mutation ArchiveSavedQuery($id: UUID!, $expectedVersion: Int!) {
  archiveSavedQuery(id: $id, expectedVersion: $expectedVersion) { id version archivedAt }
}`;
const RUN = `mutation RunSavedQuery($id: UUID!) {
  runSavedQuery(id: $id) {
    nodes { id kind title }
    pageInfo { hasNextPage endCursor }
  }
}`;

function ast(query = "Saved Needle") {
  return {
    schema: "humans.search-query",
    version: 1,
    match: { type: "text", query },
    kinds: ["PERSON"],
    filters: {},
    pageSize: 10,
  };
}

liveDescribe("Task 12 saved queries", () => {
  let fixture: ResearchFixture;

  beforeAll(async () => {
    fixture = new ResearchFixture({
      searchIndexMaintenance: createSearchIndexMaintenance({
        metrics: createTask12Metrics(disabledMetricsSink),
      }),
    });
    await fixture.reset();
  });
  beforeEach(async () => fixture.reset());
  afterAll(async () => fixture.close());

  it("enforces owner/private/workspace/API-key visibility and current execution authority", async () => {
    const owner = await fixture.createActor();
    const member = await fixture.createWorkspaceMember(owner, "analyst");
    const person = await fixture.createPerson(owner, {
      displayName: "Saved Needle Visible",
    });
    const privateCreated = await fixture.execute<{
      createSavedQuery: {
        id: string;
        name: string;
        sharing: string;
        version: number;
      };
    }>({
      jar: owner.jar,
      query: CREATE,
      variables: {
        input: {
          name: "  Private   search ",
          sharing: "PRIVATE",
          queryAst: ast(),
        },
      },
    });
    expect(privateCreated.body?.errors).toBeUndefined();
    expect(privateCreated.body?.data?.createSavedQuery).toEqual(
      expect.objectContaining({
        name: "Private search",
        sharing: "PRIVATE",
        version: 1,
      }),
    );
    const workspaceCreated = await fixture.execute<{
      createSavedQuery: { id: string; version: number };
    }>({
      jar: owner.jar,
      query: CREATE,
      variables: {
        input: {
          name: "Workspace search",
          sharing: "WORKSPACE",
          queryAst: ast(),
        },
      },
    });
    expect(workspaceCreated.body?.errors).toBeUndefined();
    const privateId = privateCreated.body?.data?.createSavedQuery.id;
    const workspaceId = workspaceCreated.body?.data?.createSavedQuery.id;
    if (!privateId || !workspaceId)
      throw new Error("Saved query fixture failed.");

    const memberList = await fixture.execute<{
      savedQueries: { nodes: Array<{ id: string }> };
    }>({ jar: member.jar, query: LIST, variables: { first: 10 } });
    expect(memberList.body?.errors).toBeUndefined();
    expect(
      memberList.body?.data?.savedQueries.nodes.map(({ id }) => id),
    ).toEqual([workspaceId]);

    const factAst = {
      ...ast("Fact AST"),
      kinds: ["FACT"],
    };
    const factCreated = await fixture.execute<{
      createSavedQuery: { id: string };
    }>({
      jar: owner.jar,
      query: CREATE,
      variables: {
        input: {
          name: "Workspace fact AST",
          sharing: "WORKSPACE",
          queryAst: factAst,
        },
      },
    });
    const factSavedId = factCreated.body?.data?.createSavedQuery.id;
    if (!factSavedId) throw new Error("Fact saved-query fixture failed.");

    const astBlindKey = await fixture.provisionKey(owner, {
      savedQuery: ["read"],
    });
    const blindList = await fixture.execute<{
      savedQueries: { nodes: Array<{ id: string }> };
    }>({
      apiKey: astBlindKey.key,
      origin: null,
      query: LIST,
      variables: { first: 10 },
    });
    expect(blindList.body?.errors).toBeUndefined();
    expect(blindList.body?.data?.savedQueries.nodes).toEqual([]);
    const blindRead = await fixture.execute<{ savedQuery: unknown }>({
      apiKey: astBlindKey.key,
      origin: null,
      query: READ,
      variables: { id: workspaceId },
    });
    expect(blindRead.body).toEqual({ data: { savedQuery: null } });
    const factOnlyKey = await fixture.provisionKey(owner, {
      savedQuery: ["read"],
      fact: ["read"],
    });
    const factBlindRead = await fixture.execute<{ savedQuery: unknown }>({
      apiKey: factOnlyKey.key,
      origin: null,
      query: READ,
      variables: { id: factSavedId },
    });
    expect(factBlindRead.body).toEqual({ data: { savedQuery: null } });

    const run = await fixture.execute<{
      runSavedQuery: { nodes: Array<{ id: string }> };
    }>({ jar: member.jar, query: RUN, variables: { id: workspaceId } });
    expect(run.body?.errors).toBeUndefined();
    expect(run.body?.data?.runSavedQuery.nodes.map(({ id }) => id)).toEqual([
      person.body?.data?.createPerson?.person?.id,
    ]);
    const personId = person.body?.data?.createPerson?.person?.id;
    if (!personId) throw new Error("Person fixture failed.");
    await fixture.database
      .update(people)
      .set({ sensitivity: "restricted" })
      .where(eq(people.id, personId));
    const reauthorized = await fixture.execute<{
      runSavedQuery: { nodes: Array<{ id: string }> };
    }>({ jar: member.jar, query: RUN, variables: { id: workspaceId } });
    expect(reauthorized.body?.errors).toBeUndefined();
    expect(reauthorized.body?.data?.runSavedQuery.nodes).toEqual([]);
    await fixture.database
      .update(people)
      .set({ sensitivity: "internal" })
      .where(eq(people.id, personId));
    expectGraphQLError(
      await fixture.execute({
        jar: member.jar,
        query: RUN,
        variables: { id: privateId },
      }),
      "NOT_FOUND",
    );

    const runKey = await fixture.provisionKey(owner, {
      savedQuery: ["read", "run"],
      search: ["read", "run"],
      person: ["read"],
    });
    const keyRun = await fixture.execute({
      apiKey: runKey.key,
      origin: null,
      query: RUN,
      variables: { id: workspaceId },
    });
    expect(keyRun.body?.errors).toBeUndefined();
    expectGraphQLError(
      await fixture.execute({
        apiKey: runKey.key,
        origin: null,
        query: RUN,
        variables: { id: privateId },
      }),
      "NOT_FOUND",
    );
    const ownershipKey = await fixture.provisionKey(owner, {
      savedQuery: ["create", "read", "run"],
      search: ["read", "run"],
      person: ["read"],
    });
    expectGraphQLError(
      await fixture.execute({
        apiKey: ownershipKey.key,
        origin: null,
        query: CREATE,
        variables: {
          input: { name: "API owner", sharing: "WORKSPACE", queryAst: ast() },
        },
      }),
      "FORBIDDEN",
    );

    const denialScopes = [
      [
        { savedQuery: ["run"], search: ["read", "run"], person: ["read"] },
        "FORBIDDEN",
      ],
      [
        { savedQuery: ["read"], search: ["read", "run"], person: ["read"] },
        "FORBIDDEN",
      ],
      [
        { savedQuery: ["read", "run"], search: ["read"], person: ["read"] },
        "FORBIDDEN",
      ],
      [
        { savedQuery: ["read", "run"], search: ["run"], person: ["read"] },
        "FORBIDDEN",
      ],
      [{ savedQuery: ["read", "run"], search: ["read", "run"] }, "NOT_FOUND"],
    ] as const;
    for (const [permissions, code] of denialScopes) {
      const key = await fixture.provisionKey(owner, permissions);
      expectGraphQLError(
        await fixture.execute({
          apiKey: key.key,
          origin: null,
          query: RUN,
          variables: { id: workspaceId },
        }),
        code,
      );
    }

    const [keyPrincipal] = await fixture.database
      .select({ id: workspacePrincipals.id })
      .from(workspacePrincipals)
      .where(eq(workspacePrincipals.apiKeyId, runKey.id));
    if (!keyPrincipal) throw new Error("API-key principal fixture failed.");
    const runRows = await fixture.database
      .select()
      .from(queryRuns)
      .where(eq(queryRuns.savedQueryId, workspaceId));
    expect(runRows).toHaveLength(4);
    expect(runRows.filter(({ outcome }) => outcome === "SUCCESS")).toHaveLength(
      3,
    );
    expect(runRows.filter(({ outcome }) => outcome === "ERROR")).toHaveLength(
      1,
    );
    expect(runRows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          actorPrincipalId: member.principalId,
          actorKind: "USER",
          queryHash: expect.stringMatching(/^[0-9a-f]{64}$/u),
        }),
        expect.objectContaining({
          actorPrincipalId: keyPrincipal.id,
          actorKind: "API_KEY",
          queryHash: expect.stringMatching(/^[0-9a-f]{64}$/u),
        }),
      ]),
    );
    expect(
      runRows.filter(
        ({ actorPrincipalId, actorKind }) =>
          actorPrincipalId === member.principalId && actorKind === "USER",
      ),
    ).toHaveLength(2);
  });

  it("uses authenticated pagination and neutral optimistic conflicts", async () => {
    const owner = await fixture.createActor();
    const ids: string[] = [];
    for (const name of ["Bravo", "Alpha", "Charlie"]) {
      const created = await fixture.execute<{
        createSavedQuery: { id: string };
      }>({
        jar: owner.jar,
        query: CREATE,
        variables: { input: { name, sharing: "PRIVATE", queryAst: ast(name) } },
      });
      const id = created.body?.data?.createSavedQuery.id;
      if (!id) throw new Error("Saved query fixture failed.");
      ids.push(id);
    }
    const first = await fixture.execute<{
      savedQueries: {
        nodes: Array<{ id: string; name: string }>;
        pageInfo: { endCursor: string };
      };
    }>({ jar: owner.jar, query: LIST, variables: { first: 1 } });
    expect(
      first.body?.data?.savedQueries.nodes.map(({ name }) => name),
    ).toEqual(["Alpha"]);
    const cursor = first.body?.data?.savedQueries.pageInfo.endCursor;
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+\.[0-9a-f]{64}$/u);
    const second = await fixture.execute<{
      savedQueries: { nodes: Array<{ name: string }> };
    }>({ jar: owner.jar, query: LIST, variables: { first: 2, after: cursor } });
    expect(
      second.body?.data?.savedQueries.nodes.map(({ name }) => name),
    ).toEqual(["Bravo", "Charlie"]);

    const updated = await fixture.execute<{
      updateSavedQuery: { version: number; sharing: string };
    }>({
      jar: owner.jar,
      query: UPDATE,
      variables: {
        input: {
          id: ids[0],
          expectedVersion: 1,
          name: "Bravo updated",
          sharing: "WORKSPACE",
          queryAst: ast("Updated"),
        },
      },
    });
    expect(updated.body?.data?.updateSavedQuery).toEqual(
      expect.objectContaining({ version: 2, sharing: "WORKSPACE" }),
    );
    expectGraphQLError(
      await fixture.execute({
        jar: owner.jar,
        query: UPDATE,
        variables: { input: { id: ids[0], expectedVersion: 1, name: "stale" } },
      }),
      "CONFLICT",
    );
    const member = await fixture.createWorkspaceMember(owner, "analyst");
    for (const attempt of [
      {
        jar: member.jar,
        variables: {
          input: { id: ids[0], expectedVersion: 2, name: "non-owner" },
        },
      },
      {
        jar: owner.jar,
        variables: {
          input: { id: newId(), expectedVersion: 1, name: "wrong id" },
        },
      },
    ]) {
      expectGraphQLError(
        await fixture.execute({ ...attempt, query: UPDATE }),
        "CONFLICT",
      );
    }
    const archived = await fixture.execute<{
      archiveSavedQuery: { archivedAt: string; version: number };
    }>({
      jar: owner.jar,
      query: ARCHIVE,
      variables: { id: ids[0], expectedVersion: 2 },
    });
    expect(archived.body?.data?.archiveSavedQuery.version).toBe(3);
    expect(archived.body?.data?.archiveSavedQuery.archivedAt).toBeTruthy();
    for (const input of [
      { id: ids[0], expectedVersion: 2 },
      { id: newId(), expectedVersion: 1 },
    ]) {
      expectGraphQLError(
        await fixture.execute({
          jar: owner.jar,
          query: ARCHIVE,
          variables: input,
        }),
        "CONFLICT",
      );
    }
    expectGraphQLError(
      await fixture.execute({
        jar: owner.jar,
        query: RUN,
        variables: { id: ids[0] },
      }),
      "NOT_FOUND",
    );
    expect(await fixture.database.select().from(savedQueries)).toHaveLength(3);
  });

  it("persists a principal-attributed redacted error run after provider rollback", async () => {
    const owner = await fixture.createActor();
    await fixture.createPerson(owner, { displayName: "Provider wait person" });
    const created = await fixture.execute<{
      createSavedQuery: { id: string };
    }>({
      jar: owner.jar,
      query: CREATE,
      variables: {
        input: {
          name: "Provider failure",
          sharing: "PRIVATE",
          queryAst: ast("Provider wait"),
        },
      },
    });
    const savedQueryId = created.body?.data?.createSavedQuery.id;
    if (!savedQueryId) throw new Error("Saved query fixture failed.");

    let markLocked!: () => void;
    let releaseLock!: () => void;
    const locked = new Promise<void>((resolve) => {
      markLocked = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    const blocker = fixture.database.transaction(async (transaction) => {
      await transaction.execute(
        sql`LOCK TABLE search_documents IN ACCESS EXCLUSIVE MODE`,
      );
      markLocked();
      await release;
    });
    await locked;
    let failed;
    try {
      failed = await fixture.execute({
        jar: owner.jar,
        query: RUN,
        variables: { id: savedQueryId },
      });
    } finally {
      releaseLock();
      await blocker;
    }
    expectGraphQLError(failed!, "PROVIDER_UNAVAILABLE");

    const runs = await fixture.database
      .select()
      .from(queryRuns)
      .where(eq(queryRuns.savedQueryId, savedQueryId));
    expect(runs).toEqual([
      expect.objectContaining({
        actorKind: "USER",
        actorPrincipalId: owner.principalId,
        outcome: "ERROR",
        queryHash: expect.stringMatching(/^[0-9a-f]{64}$/u),
        resultCount: null,
      }),
    ]);
    expect(runs[0]?.completedAt).toBeInstanceOf(Date);
    expect(runs[0]?.durationMs).toBeGreaterThanOrEqual(0);
    const failureAudits = await fixture.database
      .select({
        action: auditEvents.action,
        redactedDiff: auditEvents.redactedDiff,
      })
      .from(auditEvents)
      .where(eq(auditEvents.resourceId, savedQueryId));
    expect(failureAudits).toContainEqual({
      action: "saved_query.run_failed",
      redactedDiff: {
        changedFields: ["outcome"],
      },
    });
    expect(JSON.stringify({ failed, runs, failureAudits })).not.toContain(
      "Provider wait",
    );
  });

  it("rejects executable documents, protected exact values, and stored authority", async () => {
    const owner = await fixture.createActor();
    const invalidAsts = [
      ["GraphQL", { ...ast(), graphql: "query { people { nodes { id } } }" }],
      [
        "Protected",
        {
          ...ast(),
          match: {
            type: "protectedExact",
            kind: "PHONE",
            value: "+12125550188",
          },
        },
      ],
      ["Authority", { ...ast(), workspaceId: owner.workspaceId }],
    ] as const;
    for (const [name, queryAst] of invalidAsts) {
      expectGraphQLError(
        await fixture.execute({
          jar: owner.jar,
          query: CREATE,
          variables: {
            input: { name: `Invalid ${name}`, sharing: "PRIVATE", queryAst },
          },
        }),
        "VALIDATION_FAILED",
      );
    }
  });

  it("enforces USER-only active saved-query ownership in PostgreSQL", async () => {
    const owner = await fixture.createActor();
    const key = await fixture.provisionKey(owner, {
      savedQuery: ["create", "read"],
    });
    const [apiPrincipal] = await fixture.database
      .select({ id: workspacePrincipals.id })
      .from(workspacePrincipals)
      .where(eq(workspacePrincipals.apiKeyId, key.id));
    if (!apiPrincipal) throw new Error("API-key principal fixture failed.");
    await expect(
      fixture.database.insert(savedQueries).values({
        id: newId(),
        workspaceId: owner.workspaceId,
        ownerPrincipalId: apiPrincipal.id,
        name: "Invalid API owner",
        sharing: "WORKSPACE",
        queryAst: ast(),
        astVersion: 1,
        queryHash: "a".repeat(64),
        createdBy: apiPrincipal.id,
        updatedBy: apiPrincipal.id,
      }),
    ).rejects.toMatchObject({ cause: { code: "23514" } });
  });
});
