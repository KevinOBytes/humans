// @vitest-environment node

import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { apiKeys } from "@/db/schema/auth";
import { auditEvents } from "@/db/schema/operations";

import { expectGraphQLError } from "../support/graphql";
import { ResearchFixture } from "../support/research-fixture";

const liveDescribe = process.env.TEST_DATABASE_URL ? describe : describe.skip;

const VIEWER = /* GraphQL */ `
  query ApiKeyLifecycleViewer {
    viewer {
      actorType
      workspace {
        name
      }
    }
  }
`;

const LIST = /* GraphQL */ `
  query ApiKeyLifecycleList {
    settingsOrganizationApiKeys {
      nodes {
        actionId
        name
        state
        scopes
      }
      allowedScopes
    }
  }
`;

const CREATE = /* GraphQL */ `
  mutation ApiKeyLifecycleCreate($input: CreateOrganizationApiKeyInput!) {
    createOrganizationApiKey(input: $input) {
      actionId
      code
      requestId
      secret
    }
  }
`;

const ROTATE = /* GraphQL */ `
  mutation ApiKeyLifecycleRotate($input: RotateOrganizationApiKeyInput!) {
    rotateOrganizationApiKey(input: $input) {
      actionId
      code
      requestId
      secret
    }
  }
`;

const REVOKE = /* GraphQL */ `
  mutation ApiKeyLifecycleRevoke($input: RevokeOrganizationApiKeyInput!) {
    revokeOrganizationApiKey(input: $input) {
      actionId
      code
      requestId
      secret
    }
  }
`;

liveDescribe("HUM-FR-006 API-key lifecycle", () => {
  let fixture: ResearchFixture;

  beforeAll(async () => {
    fixture = new ResearchFixture();
    await fixture.reset();
  });
  beforeEach(async () => fixture.reset());
  afterAll(async () => fixture.close());

  it("creates, rotates, revokes, audits, and never rereads a plaintext key", async () => {
    const owner = await fixture.createActor();
    const created = await fixture.execute<{
      createOrganizationApiKey?: {
        actionId?: string | null;
        code?: string;
        secret?: string | null;
      };
    }>({
      jar: owner.jar,
      query: CREATE,
      variables: {
        input: {
          name: "Export worker",
          scopes: ["person:read", "fact:read"],
          expiresInSeconds: 30 * 24 * 60 * 60,
        },
      },
    });
    const first = created.body?.data?.createOrganizationApiKey;
    expect(first).toMatchObject({ code: "APPLIED" });
    expect(first?.actionId).toMatch(/^ak_[A-Za-z0-9_-]{43}$/u);
    expect(first?.secret).toMatch(/^hum_/u);

    const beforeRotation = await fixture.execute<{
      settingsOrganizationApiKeys?: {
        allowedScopes?: string[];
        nodes?: Array<{ actionId: string; name: string; scopes: string[] }>;
      };
    }>({ jar: owner.jar, query: LIST });
    const listed = beforeRotation.body?.data?.settingsOrganizationApiKeys;
    expect(listed?.allowedScopes).toEqual(
      expect.arrayContaining(["person:read", "fact:read"]),
    );
    expect(listed?.nodes).toEqual([
      expect.objectContaining({
        actionId: first?.actionId,
        name: "Export worker",
        scopes: ["fact:read", "person:read"],
      }),
    ]);
    expect(JSON.stringify(beforeRotation.body)).not.toContain(
      first?.secret ?? "",
    );
    expect(JSON.stringify(beforeRotation.body)).not.toContain(
      owner.workspaceId,
    );
    expect(JSON.stringify(beforeRotation.body)).not.toContain(
      owner.organizationId,
    );

    const firstCredential = await fixture.execute<{
      viewer?: { actorType?: string };
    }>({
      apiKey: first?.secret ?? "",
      query: VIEWER,
    });
    expect(firstCredential.body?.data?.viewer?.actorType).toBe("API_KEY");

    const rotated = await fixture.execute<{
      rotateOrganizationApiKey?: {
        actionId?: string | null;
        code?: string;
        secret?: string | null;
      };
    }>({
      jar: owner.jar,
      query: ROTATE,
      variables: {
        input: {
          actionId: first?.actionId,
          name: "Export worker replacement",
          scopes: ["person:read"],
          expiresInSeconds: 7 * 24 * 60 * 60,
        },
      },
    });
    const replacement = rotated.body?.data?.rotateOrganizationApiKey;
    expect(replacement).toMatchObject({ code: "APPLIED" });
    expect(replacement?.secret).toMatch(/^hum_/u);
    expect(replacement?.secret).not.toBe(first?.secret);

    expectGraphQLError(
      await fixture.execute({ apiKey: first?.secret ?? "", query: VIEWER }),
      "UNAUTHENTICATED",
    );
    expect(
      (
        await fixture.execute<{ viewer?: { actorType?: string } }>({
          apiKey: replacement?.secret ?? "",
          query: VIEWER,
        })
      ).body?.data?.viewer?.actorType,
    ).toBe("API_KEY");

    const revoked = await fixture.execute<{
      revokeOrganizationApiKey?: { actionId?: string | null; code?: string };
    }>({
      jar: owner.jar,
      query: REVOKE,
      variables: { input: { actionId: replacement?.actionId } },
    });
    expect(revoked.body?.data?.revokeOrganizationApiKey).toMatchObject({
      actionId: replacement?.actionId,
      code: "APPLIED",
    });
    expectGraphQLError(
      await fixture.execute({
        apiKey: replacement?.secret ?? "",
        query: VIEWER,
      }),
      "UNAUTHENTICATED",
    );

    const audit = await fixture.database
      .select({
        action: auditEvents.action,
        redactedDiff: auditEvents.redactedDiff,
        resourceId: auditEvents.resourceId,
      })
      .from(auditEvents)
      .where(eq(auditEvents.workspaceId, owner.workspaceId));
    expect(audit.map((row) => row.action)).toEqual(
      expect.arrayContaining([
        "settings.api_key.create",
        "settings.api_key.rotate",
        "settings.api_key.revoke",
      ]),
    );
    expect(audit.every((row) => row.resourceId === null)).toBe(true);
    expect(JSON.stringify(audit)).not.toContain(first?.secret ?? "");
    expect(JSON.stringify(audit)).not.toContain(replacement?.secret ?? "");
  });

  it("fails closed for lower roles, API-key principals, invalid inputs, and foreign action IDs", async () => {
    const owner = await fixture.createActor();
    const viewer = await fixture.createWorkspaceMember(owner, "viewer");
    const foreignOwner = await fixture.createActor();
    const foreignKey = await fixture.provisionKey(foreignOwner);
    const foreignList = await fixture.execute<{
      settingsOrganizationApiKeys?: { nodes?: Array<{ actionId: string }> };
    }>({ jar: foreignOwner.jar, query: LIST });
    const foreignActionId =
      foreignList.body?.data?.settingsOrganizationApiKeys?.nodes?.[0]?.actionId;

    expectGraphQLError(
      await fixture.execute({
        jar: viewer.jar,
        query: CREATE,
        variables: {
          input: { name: "Denied", scopes: ["person:read"] },
        },
      }),
      "FORBIDDEN",
    );
    expectGraphQLError(
      await fixture.execute({
        apiKey: foreignKey.key,
        query: CREATE,
        variables: {
          input: { name: "Denied", scopes: ["person:read"] },
        },
      }),
      "FORBIDDEN",
    );

    const invalid = await fixture.execute<{
      createOrganizationApiKey?: { code?: string; secret?: string | null };
    }>({
      jar: owner.jar,
      query: CREATE,
      variables: {
        input: { name: "Invalid", scopes: ["invalid:read"] },
      },
    });
    expect(invalid.body?.data?.createOrganizationApiKey).toEqual(
      expect.objectContaining({ code: "INVALID", secret: null }),
    );

    const foreignAction = await fixture.execute<{
      revokeOrganizationApiKey?: { code?: string };
    }>({
      jar: owner.jar,
      query: REVOKE,
      variables: { input: { actionId: foreignActionId } },
    });
    expect(foreignAction.body?.data?.revokeOrganizationApiKey).toEqual(
      expect.objectContaining({ code: "INVALID" }),
    );

    const [stillActive] = await fixture.database
      .select({ enabled: apiKeys.enabled })
      .from(apiKeys)
      .where(
        and(
          eq(apiKeys.workspaceId, foreignOwner.workspaceId),
          eq(apiKeys.configId, "organization"),
        ),
      );
    expect(stillActive?.enabled).toBe(true);
  });

  it("does not revoke the original when replacement validation fails", async () => {
    const owner = await fixture.createActor();
    const existing = await fixture.provisionKey(owner, { person: ["read"] });
    const listed = await fixture.execute<{
      settingsOrganizationApiKeys?: { nodes?: Array<{ actionId: string }> };
    }>({ jar: owner.jar, query: LIST });
    const actionId =
      listed.body?.data?.settingsOrganizationApiKeys?.nodes?.[0]?.actionId;

    const failedRotation = await fixture.execute<{
      rotateOrganizationApiKey?: { code?: string; secret?: string | null };
    }>({
      jar: owner.jar,
      query: ROTATE,
      variables: {
        input: {
          actionId,
          name: "Replacement",
          scopes: ["invalid:read"],
        },
      },
    });
    expect(failedRotation.body?.data?.rotateOrganizationApiKey).toEqual(
      expect.objectContaining({ code: "INVALID", secret: null }),
    );
    expect(
      (
        await fixture.execute<{ viewer?: { actorType?: string } }>({
          apiKey: existing.key,
          query: VIEWER,
        })
      ).body?.data?.viewer?.actorType,
    ).toBe("API_KEY");
  });
});
