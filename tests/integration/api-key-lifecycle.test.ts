// @vitest-environment node

import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { apiKeys, members } from "@/db/schema/auth";
import { locationMutationIdempotency } from "@/db/schema/locations";
import { auditEvents } from "@/db/schema/operations";
import { RevokeOrganizationApiKeyDocument } from "@/graphql/generated/graphql";

import { TestEmailSender, testAdminEnv } from "../support/auth";
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
      replayed
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
      replayed
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
  let beforeApiKeyLifecycleWrite: (() => Promise<void> | void) | undefined;
  let afterApiKeyLifecycleStep:
    | ((
        step: "created" | "staged" | "before_audit" | "before_rotation_disable",
      ) => Promise<void> | void)
    | undefined;

  beforeAll(async () => {
    fixture = new ResearchFixture({
      settingsRuntime: {
        appUrl: testAdminEnv.NEXT_PUBLIC_APP_URL,
        authSecret: testAdminEnv.AUTH_SECRET,
        beforeApiKeyLifecycleWrite: () => beforeApiKeyLifecycleWrite?.(),
        afterApiKeyLifecycleStep: (step) => afterApiKeyLifecycleStep?.(step),
        emailSender: new TestEmailSender(),
        encryptionKey: testAdminEnv.AUTH_ENCRYPTION_KEY,
      },
    });
    await fixture.reset();
  });
  beforeEach(async () => {
    beforeApiKeyLifecycleWrite = undefined;
    afterApiKeyLifecycleStep = undefined;
    await fixture.reset();
  });
  afterAll(async () => fixture.close());

  it("creates, rotates, revokes, audits, and never rereads a plaintext key", async () => {
    const owner = await fixture.createActor();
    const created = await fixture.execute<{
      createOrganizationApiKey?: {
        actionId?: string | null;
        code?: string;
        requestId?: string;
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
        requestId?: string;
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
      revokeOrganizationApiKey?: {
        actionId?: string | null;
        code?: string;
        requestId?: string;
      };
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
        actorUserId: auditEvents.actorUserId,
        redactedDiff: auditEvents.redactedDiff,
        resourceId: auditEvents.resourceId,
        requestId: auditEvents.requestId,
        sessionId: auditEvents.sessionId,
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
    const lifecycleAudit = audit.filter((row) =>
      [
        "settings.api_key.create",
        "settings.api_key.rotate",
        "settings.api_key.revoke",
      ].includes(row.action),
    );
    expect(lifecycleAudit).toHaveLength(3);
    expect(lifecycleAudit).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: "settings.api_key.create",
          actorUserId: owner.userId,
          requestId: first?.requestId,
          sessionId: expect.any(String),
        }),
        expect.objectContaining({
          action: "settings.api_key.rotate",
          actorUserId: owner.userId,
          requestId: replacement?.requestId,
          sessionId: expect.any(String),
        }),
        expect.objectContaining({
          action: "settings.api_key.revoke",
          actorUserId: owner.userId,
          requestId: revoked.body?.data?.revokeOrganizationApiKey?.requestId,
          sessionId: expect.any(String),
        }),
      ]),
    );
    expect(JSON.stringify(audit)).not.toContain(first?.secret ?? "");
    expect(JSON.stringify(audit)).not.toContain(replacement?.secret ?? "");
  });

  it("converges concurrent create retries without persisting or replaying the plaintext secret", async () => {
    const owner = await fixture.createActor();
    const input = {
      name: "Retry-safe export worker",
      scopes: ["person:read", "fact:read"],
      expiresInSeconds: 30 * 24 * 60 * 60,
      idempotencyKey: "api-key-create-concurrent-v1",
    };
    const responses = await Promise.all(
      [0, 1].map(() =>
        fixture.execute<{
          createOrganizationApiKey?: {
            actionId: string | null;
            code: string;
            replayed: boolean;
            requestId: string;
            secret: string | null;
          };
        }>({ jar: owner.jar, query: CREATE, variables: { input } }),
      ),
    );
    const payloads = responses.map(
      (response) => response.body?.data?.createOrganizationApiKey,
    );
    expect(responses.map((response) => response.body?.errors)).toEqual([
      undefined,
      undefined,
    ]);
    expect(payloads.map((payload) => payload?.code)).toEqual([
      "APPLIED",
      "APPLIED",
    ]);
    expect(new Set(payloads.map((payload) => payload?.actionId))).toHaveLength(
      1,
    );
    expect(payloads.map((payload) => payload?.replayed).sort()).toEqual([
      false,
      true,
    ]);
    const secrets = payloads
      .map((payload) => payload?.secret)
      .filter((secret): secret is string => typeof secret === "string");
    expect(secrets).toHaveLength(1);
    expect(secrets[0]).toMatch(/^hum_/u);

    const storedKeys = await fixture.database
      .select({ enabled: apiKeys.enabled, key: apiKeys.key })
      .from(apiKeys)
      .where(eq(apiKeys.workspaceId, owner.workspaceId));
    expect(storedKeys).toHaveLength(1);
    expect(storedKeys[0]).toMatchObject({ enabled: true });
    expect(storedKeys[0]?.key).not.toBe(secrets[0]);
    expect(storedKeys[0]?.key).not.toContain(secrets[0]);
    expect(
      (
        await fixture.execute<{ viewer?: { actorType?: string } }>({
          apiKey: secrets[0] ?? "",
          query: VIEWER,
        })
      ).body?.data?.viewer?.actorType,
    ).toBe("API_KEY");

    expect(
      await fixture.database
        .select({ id: auditEvents.id })
        .from(auditEvents)
        .where(
          and(
            eq(auditEvents.workspaceId, owner.workspaceId),
            eq(auditEvents.action, "settings.api_key.create"),
          ),
        ),
    ).toHaveLength(1);
    const claims = await fixture.database
      .select({
        responseReference: locationMutationIdempotency.responseReference,
      })
      .from(locationMutationIdempotency)
      .where(
        and(
          eq(locationMutationIdempotency.workspaceId, owner.workspaceId),
          eq(locationMutationIdempotency.operation, "settings.api_key.create"),
        ),
      );
    expect(claims).toHaveLength(1);
    expect(claims[0]?.responseReference).toEqual({
      actionId: payloads[0]?.actionId,
      code: "APPLIED",
      requestId: payloads[0]?.requestId,
    });
    expect(JSON.stringify(claims[0]?.responseReference)).not.toContain(
      secrets[0] ?? "missing-secret",
    );
  });

  it("converges concurrent rotation retries with one replacement and one transient secret", async () => {
    const owner = await fixture.createActor();
    const original = await fixture.provisionKey(owner, { person: ["read"] });
    const listed = await fixture.execute<{
      settingsOrganizationApiKeys?: { nodes?: Array<{ actionId: string }> };
    }>({ jar: owner.jar, query: LIST });
    const originalActionId =
      listed.body?.data?.settingsOrganizationApiKeys?.nodes?.[0]?.actionId;
    const input = {
      actionId: originalActionId,
      name: "Retry-safe replacement",
      scopes: ["person:read"],
      idempotencyKey: "api-key-rotate-concurrent-v1",
    };
    const responses = await Promise.all(
      [0, 1].map(() =>
        fixture.execute<{
          rotateOrganizationApiKey?: {
            actionId: string | null;
            code: string;
            replayed: boolean;
            requestId: string;
            secret: string | null;
          };
        }>({ jar: owner.jar, query: ROTATE, variables: { input } }),
      ),
    );
    const payloads = responses.map(
      (response) => response.body?.data?.rotateOrganizationApiKey,
    );
    expect(responses.map((response) => response.body?.errors)).toEqual([
      undefined,
      undefined,
    ]);
    expect(new Set(payloads.map((payload) => payload?.actionId))).toHaveLength(
      1,
    );
    expect(payloads.map((payload) => payload?.replayed).sort()).toEqual([
      false,
      true,
    ]);
    const secrets = payloads
      .map((payload) => payload?.secret)
      .filter((secret): secret is string => typeof secret === "string");
    expect(secrets).toHaveLength(1);
    expectGraphQLError(
      await fixture.execute({ apiKey: original.key, query: VIEWER }),
      "UNAUTHENTICATED",
    );
    expect(
      (
        await fixture.execute<{ viewer?: { actorType?: string } }>({
          apiKey: secrets[0] ?? "",
          query: VIEWER,
        })
      ).body?.data?.viewer?.actorType,
    ).toBe("API_KEY");
    const storedKeys = await fixture.database
      .select({ enabled: apiKeys.enabled })
      .from(apiKeys)
      .where(eq(apiKeys.workspaceId, owner.workspaceId));
    expect(storedKeys).toHaveLength(2);
    expect(storedKeys).toEqual(
      expect.arrayContaining([{ enabled: false }, { enabled: true }]),
    );
    expect(
      await fixture.database
        .select({ id: auditEvents.id })
        .from(auditEvents)
        .where(
          and(
            eq(auditEvents.workspaceId, owner.workspaceId),
            eq(auditEvents.action, "settings.api_key.rotate"),
          ),
        ),
    ).toHaveLength(1);
    const claims = await fixture.database
      .select({
        responseReference: locationMutationIdempotency.responseReference,
      })
      .from(locationMutationIdempotency)
      .where(
        and(
          eq(locationMutationIdempotency.workspaceId, owner.workspaceId),
          eq(locationMutationIdempotency.operation, "settings.api_key.rotate"),
        ),
      );
    expect(claims).toHaveLength(1);
    expect(Object.hasOwn(claims[0]?.responseReference ?? {}, "secret")).toBe(
      false,
    );
  });

  it("binds API-key create replay to request material and workspace principal", async () => {
    const owner = await fixture.createActor();
    const foreignOwner = await fixture.createActor();
    const idempotencyKey = "api-key-create-workspace-fence-v1";
    const first = await fixture.execute({
      jar: owner.jar,
      query: CREATE,
      variables: {
        input: {
          idempotencyKey,
          name: "Bound request",
          scopes: ["person:read"],
        },
      },
    });
    expect(first.body?.errors).toBeUndefined();

    expectGraphQLError(
      await fixture.execute({
        jar: owner.jar,
        query: CREATE,
        variables: {
          input: {
            idempotencyKey,
            name: "Changed request",
            scopes: ["person:read"],
          },
        },
      }),
      "CONFLICT",
    );
    const foreign = await fixture.execute({
      jar: foreignOwner.jar,
      query: CREATE,
      variables: {
        input: {
          idempotencyKey,
          name: "Independent request",
          scopes: ["person:read"],
        },
      },
    });
    expect(foreign.body?.errors).toBeUndefined();
    expect(
      await fixture.database
        .select({ id: apiKeys.id })
        .from(apiKeys)
        .where(eq(apiKeys.workspaceId, owner.workspaceId)),
    ).toHaveLength(1);
    expect(
      await fixture.database
        .select({ id: apiKeys.id })
        .from(apiKeys)
        .where(eq(apiKeys.workspaceId, foreignOwner.workspaceId)),
    ).toHaveLength(1);
  });

  it("durably replays concurrent API-key revocation without duplicate effects", async () => {
    const owner = await fixture.createActor();
    await fixture.provisionKey(owner, { person: ["read"] });
    const listed = await fixture.execute<{
      settingsOrganizationApiKeys?: { nodes?: Array<{ actionId: string }> };
    }>({ jar: owner.jar, query: LIST });
    const actionId =
      listed.body?.data?.settingsOrganizationApiKeys?.nodes?.[0]?.actionId;
    expect(actionId).toBeTruthy();

    const input = {
      actionId,
      idempotencyKey: "api-key-revoke-concurrent-v1",
    };
    const [first, replay] = await Promise.all([
      fixture.execute<{
        revokeOrganizationApiKey?: {
          actionId: string | null;
          code: string;
          requestId: string;
        };
      }>({
        jar: owner.jar,
        operationName: "RevokeOrganizationApiKey",
        query: RevokeOrganizationApiKeyDocument,
        variables: { input },
      }),
      fixture.execute<{
        revokeOrganizationApiKey?: {
          actionId: string | null;
          code: string;
          requestId: string;
        };
      }>({
        jar: owner.jar,
        operationName: "RevokeOrganizationApiKey",
        query: RevokeOrganizationApiKeyDocument,
        variables: { input },
      }),
    ]);

    expect(first.body?.errors).toBeUndefined();
    expect(replay.body?.errors).toBeUndefined();
    expect(first.body?.data?.revokeOrganizationApiKey).toEqual(
      replay.body?.data?.revokeOrganizationApiKey,
    );
    expect(first.body?.data?.revokeOrganizationApiKey).toMatchObject({
      actionId,
      code: "APPLIED",
    });
    expect(
      await fixture.database
        .select({ id: auditEvents.id })
        .from(auditEvents)
        .where(
          and(
            eq(auditEvents.workspaceId, owner.workspaceId),
            eq(auditEvents.action, "settings.api_key.revoke"),
          ),
        ),
    ).toHaveLength(1);
    expect(
      await fixture.database
        .select({ id: locationMutationIdempotency.id })
        .from(locationMutationIdempotency)
        .where(
          and(
            eq(locationMutationIdempotency.workspaceId, owner.workspaceId),
            eq(
              locationMutationIdempotency.operation,
              "settings.api_key.revoke",
            ),
          ),
        ),
    ).toHaveLength(1);
  });

  it("binds API-key revocation replay to request material and workspace principal", async () => {
    const owner = await fixture.createActor();
    const foreignOwner = await fixture.createActor();
    await fixture.provisionKey(owner, { person: ["read"] });
    await fixture.provisionKey(owner, { fact: ["read"] });
    await fixture.provisionKey(foreignOwner, { person: ["read"] });
    const ownerList = await fixture.execute<{
      settingsOrganizationApiKeys?: {
        nodes?: Array<{ actionId: string; name: string }>;
      };
    }>({ jar: owner.jar, query: LIST });
    const foreignList = await fixture.execute<{
      settingsOrganizationApiKeys?: {
        nodes?: Array<{ actionId: string; name: string }>;
      };
    }>({ jar: foreignOwner.jar, query: LIST });
    const firstActionId =
      ownerList.body?.data?.settingsOrganizationApiKeys?.nodes?.[0]?.actionId;
    const secondActionId =
      ownerList.body?.data?.settingsOrganizationApiKeys?.nodes?.[1]?.actionId;
    const foreignActionId =
      foreignList.body?.data?.settingsOrganizationApiKeys?.nodes?.[0]?.actionId;
    expect(firstActionId).toBeTruthy();
    expect(secondActionId).toBeTruthy();
    expect(secondActionId).not.toBe(firstActionId);
    expect(foreignActionId).toBeTruthy();
    const idempotencyKey = "api-key-revoke-workspace-fence-v1";

    const first = await fixture.execute({
      jar: owner.jar,
      operationName: "RevokeOrganizationApiKey",
      query: RevokeOrganizationApiKeyDocument,
      variables: {
        input: { actionId: firstActionId, idempotencyKey },
      },
    });
    expect(first.body?.errors).toBeUndefined();

    const changed = await fixture.execute({
      jar: owner.jar,
      operationName: "RevokeOrganizationApiKey",
      query: RevokeOrganizationApiKeyDocument,
      variables: {
        input: { actionId: secondActionId, idempotencyKey },
      },
    });
    expectGraphQLError(changed, "CONFLICT");
    const ownerKeys = await fixture.database
      .select({ enabled: apiKeys.enabled })
      .from(apiKeys)
      .where(eq(apiKeys.workspaceId, owner.workspaceId));
    expect(ownerKeys.map((row) => row.enabled).sort()).toEqual([false, true]);

    const foreign = await fixture.execute({
      jar: foreignOwner.jar,
      operationName: "RevokeOrganizationApiKey",
      query: RevokeOrganizationApiKeyDocument,
      variables: {
        input: { actionId: foreignActionId, idempotencyKey },
      },
    });
    expect(foreign.body?.errors).toBeUndefined();
    expect(foreign.body?.data?.revokeOrganizationApiKey).toMatchObject({
      actionId: foreignActionId,
      code: "APPLIED",
    });
  });

  it("fails closed when an API-key revocation replay reference is malformed", async () => {
    const owner = await fixture.createActor();
    await fixture.provisionKey(owner, { person: ["read"] });
    const listed = await fixture.execute<{
      settingsOrganizationApiKeys?: { nodes?: Array<{ actionId: string }> };
    }>({ jar: owner.jar, query: LIST });
    const actionId =
      listed.body?.data?.settingsOrganizationApiKeys?.nodes?.[0]?.actionId;
    const input = {
      actionId,
      idempotencyKey: "api-key-revoke-malformed-reference-v1",
    };
    const revoked = await fixture.execute({
      jar: owner.jar,
      operationName: "RevokeOrganizationApiKey",
      query: RevokeOrganizationApiKeyDocument,
      variables: { input },
    });
    expect(revoked.body?.errors).toBeUndefined();

    await fixture.database
      .update(locationMutationIdempotency)
      .set({
        responseReference: {
          actionId: null,
          code: "APPLIED",
          requestId: "not-a-request-id",
        },
      })
      .where(
        and(
          eq(locationMutationIdempotency.workspaceId, owner.workspaceId),
          eq(locationMutationIdempotency.operation, "settings.api_key.revoke"),
        ),
      );
    expectGraphQLError(
      await fixture.execute({
        jar: owner.jar,
        operationName: "RevokeOrganizationApiKey",
        query: RevokeOrganizationApiKeyDocument,
        variables: { input },
      }),
      "PRECONDITION_FAILED",
    );
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

  it.each(["demotion", "removal"] as const)(
    "does not create a key after an admin %s before the locked write",
    async (change) => {
      const owner = await fixture.createActor();
      const admin = await fixture.createWorkspaceMember(owner, "admin");
      beforeApiKeyLifecycleWrite = async () => {
        if (change === "demotion") {
          await fixture.database
            .update(members)
            .set({ role: "viewer" })
            .where(eq(members.id, admin.memberId));
          return;
        }
        await fixture.database
          .delete(members)
          .where(eq(members.id, admin.memberId));
      };

      const denied = await fixture.execute<{
        createOrganizationApiKey?: {
          actionId?: string | null;
          code?: string;
          secret?: string | null;
        };
      }>({
        jar: admin.jar,
        query: CREATE,
        variables: {
          input: { name: "Denied", scopes: ["person:read"] },
        },
      });
      expect(denied.body?.data?.createOrganizationApiKey).toEqual(
        expect.objectContaining({
          actionId: null,
          code: "INVALID",
          secret: null,
        }),
      );
      expect(
        await fixture.database
          .select({ id: apiKeys.id })
          .from(apiKeys)
          .where(eq(apiKeys.workspaceId, owner.workspaceId)),
      ).toHaveLength(0);
    },
  );

  it.each(["created", "staged", "before_audit"] as const)(
    "rolls back the entire API-key lifecycle when %s finalization fails",
    async (failedStep) => {
      const owner = await fixture.createActor();
      afterApiKeyLifecycleStep = (step) => {
        if (step === failedStep)
          throw new Error("injected finalization failure");
      };
      const failed = await fixture.execute({
        jar: owner.jar,
        query: CREATE,
        variables: {
          input: { name: "Failed create", scopes: ["person:read"] },
        },
      });
      expect(failed.body?.errors).toBeDefined();
      const rows = await fixture.database
        .select({ enabled: apiKeys.enabled })
        .from(apiKeys)
        .where(eq(apiKeys.workspaceId, owner.workspaceId));
      expect(rows).toHaveLength(0);
      expect(
        await fixture.database
          .select({ id: auditEvents.id })
          .from(auditEvents)
          .where(
            and(
              eq(auditEvents.workspaceId, owner.workspaceId),
              eq(auditEvents.action, "settings.api_key.create"),
            ),
          ),
      ).toHaveLength(0);
    },
  );

  it("disables the direct replacement ID when rotation final-disable fails", async () => {
    const owner = await fixture.createActor();
    const existing = await fixture.provisionKey(owner, { person: ["read"] });
    const listed = await fixture.execute<{
      settingsOrganizationApiKeys?: { nodes?: Array<{ actionId: string }> };
    }>({ jar: owner.jar, query: LIST });
    afterApiKeyLifecycleStep = (step) => {
      if (step === "before_rotation_disable") {
        throw new Error("injected final-disable failure");
      }
    };
    const failed = await fixture.execute({
      jar: owner.jar,
      query: ROTATE,
      variables: {
        input: {
          actionId:
            listed.body?.data?.settingsOrganizationApiKeys?.nodes?.[0]
              ?.actionId,
          name: "Failed replacement",
          scopes: ["person:read"],
        },
      },
    });
    expect(failed.body?.errors).toBeDefined();
    const rows = await fixture.database
      .select({ enabled: apiKeys.enabled, name: apiKeys.name })
      .from(apiKeys)
      .where(eq(apiKeys.workspaceId, owner.workspaceId));
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ enabled: true, name: existing.name }),
        expect.objectContaining({ enabled: false, name: "Failed replacement" }),
      ]),
    );
  });

  it.each(["demotion", "removal"] as const)(
    "revalidates an admin %s inside the disable transaction",
    async (change) => {
      const owner = await fixture.createActor();
      const admin = await fixture.createWorkspaceMember(owner, "admin");
      await fixture.provisionKey(owner, { person: ["read"] });
      const listed = await fixture.execute<{
        settingsOrganizationApiKeys?: { nodes?: Array<{ actionId: string }> };
      }>({ jar: admin.jar, query: LIST });
      const actionId =
        listed.body?.data?.settingsOrganizationApiKeys?.nodes?.[0]?.actionId;

      beforeApiKeyLifecycleWrite = async () => {
        if (change === "demotion") {
          await fixture.database
            .update(members)
            .set({ role: "viewer" })
            .where(eq(members.id, admin.memberId));
          return;
        }
        await fixture.database
          .delete(members)
          .where(eq(members.id, admin.memberId));
      };

      const denied = await fixture.execute<{
        revokeOrganizationApiKey?: {
          actionId?: string | null;
          code?: string;
          requestId?: string;
          secret?: string | null;
        };
      }>({
        jar: admin.jar,
        query: REVOKE,
        variables: { input: { actionId } },
      });
      expect(denied.body?.data?.revokeOrganizationApiKey).toEqual({
        actionId: null,
        code: "INVALID",
        requestId: expect.any(String),
        secret: null,
      });
      const [stored] = await fixture.database
        .select({ enabled: apiKeys.enabled })
        .from(apiKeys)
        .where(eq(apiKeys.workspaceId, owner.workspaceId));
      expect(stored?.enabled).toBe(true);
      const deniedAudit = await fixture.database
        .select({ id: auditEvents.id })
        .from(auditEvents)
        .where(
          and(
            eq(auditEvents.workspaceId, owner.workspaceId),
            eq(auditEvents.action, "settings.api_key.revoke"),
          ),
        );
      expect(deniedAudit).toHaveLength(0);
    },
  );
});
