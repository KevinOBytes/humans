// @vitest-environment node

import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { newId } from "@/db/id";
import { auditEvents } from "@/db/schema/operations";
import { people } from "@/db/schema/people";
import { searchDocuments } from "@/db/schema/search";
import { BULK_QUERY_ALERT_RESULT_THRESHOLD } from "@/modules/search/service";

import type { SessionActor } from "../support/graphql";
import { ResearchFixture } from "../support/research-fixture";

const liveDescribe = process.env.TEST_DATABASE_URL ? describe : describe.skip;

const SEARCH = /* GraphQL */ `
  query Search($input: SearchInput!) {
    search(input: $input) {
      nodes {
        id
      }
      pageInfo {
        hasNextPage
      }
    }
  }
`;

type SearchResult = {
  search: {
    nodes: Array<{ id: string }>;
    pageInfo: { hasNextPage: boolean };
  };
};

async function seedSearchPeople(
  fixture: ResearchFixture,
  actor: SessionActor,
  count: number,
): Promise<void> {
  const now = new Date();
  const rows = Array.from({ length: count }, (_, index) => {
    const id = newId();
    const displayName = `Bulk Query Needle ${String(index).padStart(3, "0")}`;
    return { id, displayName };
  });
  await fixture.database.insert(people).values(
    rows.map(({ id, displayName }) => ({
      id,
      workspaceId: actor.workspaceId,
      displayName,
      status: "active" as const,
      sensitivity: "public" as const,
      confidence: "1",
      version: 1,
      createdAt: now,
      createdBy: actor.principalId,
      updatedAt: now,
      updatedBy: actor.principalId,
    })),
  );
  await fixture.database.insert(searchDocuments).values(
    rows.map(({ id, displayName }) => ({
      id: newId(),
      workspaceId: actor.workspaceId,
      resourceKind: "person",
      resourceId: id,
      sourceVersion: 1,
      resultKind: "PERSON" as const,
      resultId: id,
      subjectPersonId: id,
      sensitivity: "public" as const,
      redactedText: displayName,
      bodyText: "",
      displayText: displayName,
      updatedAt: now,
    })),
  );
}

liveDescribe("bulk search audit alert", () => {
  let fixture: ResearchFixture;

  beforeAll(async () => {
    fixture = new ResearchFixture();
  });

  beforeEach(async () => fixture.reset());
  afterAll(async () => fixture.close());

  it("persists one redacted alert at the page threshold and deduplicates retries", async () => {
    const actor = await fixture.createActor();
    await seedSearchPeople(
      fixture,
      actor,
      BULK_QUERY_ALERT_RESULT_THRESHOLD + 1,
    );
    const variables = {
      input: {
        version: 1,
        match: { type: "TEXT", query: "Bulk Query Needle" },
        kinds: ["PERSON"],
        filters: {},
        first: BULK_QUERY_ALERT_RESULT_THRESHOLD,
      },
    };

    const [first, replay] = await Promise.all([
      fixture.execute<SearchResult>({
        jar: actor.jar,
        query: SEARCH,
        variables,
      }),
      fixture.execute<SearchResult>({
        jar: actor.jar,
        query: SEARCH,
        variables,
      }),
    ]);
    expect(first.body?.errors).toBeUndefined();
    expect(replay.body?.errors).toBeUndefined();
    expect(first.body?.data?.search.nodes).toHaveLength(
      BULK_QUERY_ALERT_RESULT_THRESHOLD,
    );
    expect(first.body?.data?.search.pageInfo.hasNextPage).toBe(true);

    const alerts = await fixture.database
      .select({
        redactedDiff: auditEvents.redactedDiff,
        resourceId: auditEvents.resourceId,
      })
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.workspaceId, actor.workspaceId),
          eq(auditEvents.action, "search.bulk_alert"),
        ),
      );
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.resourceId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/u,
    );
    expect(alerts[0]?.redactedDiff).toEqual({
      changedFields: ["resultCount"],
      metadata: {
        hasNextPage: true,
        queryMode: "TEXT",
        rowCount: BULK_QUERY_ALERT_RESULT_THRESHOLD,
        threshold: BULK_QUERY_ALERT_RESULT_THRESHOLD,
      },
    });
    expect(JSON.stringify(alerts[0]?.redactedDiff)).not.toContain(
      "Bulk Query Needle",
    );
  });

  it("keeps bulk alerts isolated to each workspace", async () => {
    const firstActor = await fixture.createActor();
    const secondActor = await fixture.createActor();
    await seedSearchPeople(
      fixture,
      firstActor,
      BULK_QUERY_ALERT_RESULT_THRESHOLD,
    );
    await seedSearchPeople(
      fixture,
      secondActor,
      BULK_QUERY_ALERT_RESULT_THRESHOLD,
    );
    const variables = {
      input: {
        version: 1,
        match: { type: "TEXT", query: "Bulk Query Needle" },
        kinds: ["PERSON"],
        filters: {},
        first: BULK_QUERY_ALERT_RESULT_THRESHOLD,
      },
    };
    for (const actor of [firstActor, secondActor]) {
      const result = await fixture.execute<SearchResult>({
        jar: actor.jar,
        query: SEARCH,
        variables,
      });
      expect(result.body?.errors).toBeUndefined();
    }

    const alerts = await fixture.database
      .select({ workspaceId: auditEvents.workspaceId })
      .from(auditEvents)
      .where(eq(auditEvents.action, "search.bulk_alert"));
    expect(alerts).toHaveLength(2);
    expect(new Set(alerts.map(({ workspaceId }) => workspaceId))).toEqual(
      new Set([firstActor.workspaceId, secondActor.workspaceId]),
    );
  });
});
