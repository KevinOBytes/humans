// @vitest-environment node

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import { newId } from "@/db/id";
import { seedDatabase } from "@/db/seed";
import { members, sessions } from "@/db/schema/auth";
import {
  PeopleListDocument,
  PersonHeaderDocument,
} from "@/graphql/generated/graphql";
import { ensureUserPrincipal } from "@/modules/auth/workspaces";

import { ResearchFixture } from "../support/research-fixture";

const databaseUrl = process.env.TEST_DATABASE_URL;
const live = databaseUrl ? describe : describe.skip;

const atlas = {
  organizationId: "01900000-0000-7000-8000-000000000201",
  personIds: [
    "01900000-0000-7000-8000-000000000011",
    "01900000-0000-7000-8000-000000000012",
    "01900000-0000-7000-8000-000000000013",
    "01900000-0000-7000-8000-000000000014",
  ],
  workspaceId: "01900000-0000-7000-8000-000000000001",
} as const;
const sandboxPersonId = "01900000-0000-7000-8000-000000000021";

live("fictional seed PostgreSQL and generated GraphQL lifecycle", () => {
  let fixture: ResearchFixture;

  beforeAll(() => {
    fixture = new ResearchFixture();
  });
  beforeEach(async () => {
    delete process.env.ALLOW_DATABASE_SEED;
    await fixture.reset();
  });
  afterAll(async () => {
    delete process.env.ALLOW_DATABASE_SEED;
    await fixture.close();
  });

  it("rejects the runtime seed path when the explicit non-test guard is absent", async () => {
    const guardedTarget = new URL(databaseUrl!);
    guardedTarget.pathname = "/humans_seed_guard_target";

    await expect(seedDatabase(guardedTarget.toString())).rejects.toThrow(
      /ALLOW_DATABASE_SEED=true/u,
    );
  });

  it("replays idempotently and exposes only Atlas fiction through authorized generated reads", async () => {
    process.env.ALLOW_DATABASE_SEED = "true";
    await seedDatabase(databaseUrl!);
    await seedDatabase(databaseUrl!);

    const reader = await fixture.createUser({
      email: `seed-reader-${newId()}@example.test`,
      username: `SeedReader_${newId().replaceAll("-", "")}`,
    });
    const memberId = newId();
    await fixture.database.insert(members).values({
      createdAt: new Date(),
      id: memberId,
      organizationId: atlas.organizationId,
      role: "viewer",
      userId: reader.userId,
      workspaceId: atlas.workspaceId,
    });
    await ensureUserPrincipal(fixture.database, {
      memberId,
      userId: reader.userId,
      workspaceId: atlas.workspaceId,
    });
    await fixture.database
      .update(sessions)
      .set({ activeOrganizationId: atlas.organizationId })
      .where(eq(sessions.userId, reader.userId));

    const people = await fixture.execute<{
      people: { nodes: Array<{ displayName: string; id: string }> };
    }>({
      jar: reader.jar,
      operationName: "PeopleList",
      query: PeopleListDocument,
      variables: { first: 10 },
    });
    expect(people.body?.errors).toBeUndefined();
    expect(people.body?.data?.people.nodes).toHaveLength(4);
    expect(people.body?.data?.people.nodes.map(({ id }) => id)).toEqual(
      expect.arrayContaining([...atlas.personIds]),
    );
    expect(
      people.body?.data?.people.nodes.map(({ displayName }) => displayName),
    ).toEqual(
      expect.arrayContaining([
        "Mira Quill",
        "Rowan Vale",
        "Sol Ember",
        "Tavi North",
      ]),
    );

    const hiddenSandboxPerson = await fixture.execute<{
      person: { id: string } | null;
    }>({
      jar: reader.jar,
      operationName: "PersonHeader",
      query: PersonHeaderDocument,
      variables: { id: sandboxPersonId },
    });
    expect(hiddenSandboxPerson.body?.errors).toBeUndefined();
    expect(hiddenSandboxPerson.body?.data?.person).toBeNull();

    const [counts] = await fixture.connection<
      [
        {
          facts: number;
          people: number;
          relationships: number;
          sources: number;
          workspaces: number;
        },
      ]
    >`
      SELECT
        (SELECT count(*)::int FROM facts) AS facts,
        (SELECT count(*)::int FROM people) AS people,
        (SELECT count(*)::int FROM relationships) AS relationships,
        (SELECT count(*)::int FROM sources) AS sources,
        (SELECT count(*)::int FROM workspaces) AS workspaces
    `;
    expect(counts).toEqual({
      facts: 12,
      people: 5,
      relationships: 2,
      sources: 1,
      workspaces: 2,
    });
  });
});
