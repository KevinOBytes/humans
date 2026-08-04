// @vitest-environment node

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { newId } from "@/db/id";

import {
  GraphQLFixture,
  createSyntheticGraphQLSchema,
  expectGraphQLError,
} from "../support/graphql";

const liveDescribe = process.env.TEST_DATABASE_URL ? describe : describe.skip;

liveDescribe("GraphQL tenant isolation", () => {
  let fixture: GraphQLFixture;

  beforeAll(() => {
    fixture = new GraphQLFixture({
      schema: createSyntheticGraphQLSchema(),
    });
  });
  beforeEach(async () => fixture.reset());
  afterAll(async () => fixture.close());

  it("ignores workspace headers and variables for session and API-key actors", async () => {
    const actorA = await fixture.createSessionActor({ name: "Tenant A" });
    const actorB = await fixture.createSessionActor({ name: "Tenant B" });
    const keyA = await fixture.provisionKey(actorA);

    for (const credentials of [
      { jar: actorA.jar },
      { apiKey: keyA.key, origin: null },
    ]) {
      const result = await fixture.execute<{
        workspace: { id: string; name: string };
      }>({
        ...credentials,
        headers: { "x-workspace-id": actorB.workspaceId },
        query: `query TenantSelection {
          workspace { id name }
        }`,
        variables: { workspaceId: actorB.workspaceId },
      });
      expect(result.body?.errors).toBeUndefined();
      expect(result.body?.data?.workspace).toEqual({
        id: actorA.workspaceId,
        name: "Tenant A",
      });
    }
  });

  it("scopes loaders to one workspace, preserves key order, and hides foreign rows", async () => {
    const actorA = await fixture.createSessionActor({ name: "Tenant A" });
    const actorB = await fixture.createSessionActor({ name: "Tenant B" });
    const query = `query WorkspaceLoads($ids: [UUID!]!) {
      workspaceLoads(ids: $ids) { id name }
    }`;
    const result = await fixture.execute<{
      workspaceLoads: Array<{ id: string; name: string } | null>;
    }>({
      jar: actorA.jar,
      query,
      variables: {
        ids: [
          actorA.workspaceId,
          actorB.workspaceId,
          actorA.workspaceId,
          newId(),
        ],
      },
    });

    expect(result.body?.errors).toBeUndefined();
    expect(result.body?.data?.workspaceLoads).toEqual([
      { id: actorA.workspaceId, name: "Tenant A" },
      null,
      { id: actorA.workspaceId, name: "Tenant A" },
      null,
    ]);
  });

  it("does not reveal foreign workspace existence through permission failures", async () => {
    const actorA = await fixture.createSessionActor({ role: "viewer" });
    const actorB = await fixture.createSessionActor();
    const result = await fixture.execute({
      jar: actorA.jar,
      query: `query Probe($workspaceId: UUID!) {
        tenantProbe(workspaceId: $workspaceId)
      }`,
      variables: { workspaceId: actorB.workspaceId },
    });
    expectGraphQLError(result, "FORBIDDEN");
    expect(JSON.stringify(result.body)).not.toContain(actorB.workspaceId);
  });
});
