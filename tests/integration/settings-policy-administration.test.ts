// @vitest-environment node

import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  CreateAccessPolicyDocument,
  SettingsPolicyPostureDocument,
  UpdateAccessPolicyDocument,
  UpdateWorkspaceDefaultsDocument,
} from "@/graphql/generated/graphql";
import { auditEvents, idempotencyKeys } from "@/db/schema/operations";

import { expectGraphQLError } from "../support/graphql";
import { ResearchFixture } from "../support/research-fixture";

const liveDescribe = process.env.TEST_DATABASE_URL ? describe : describe.skip;

liveDescribe("settings policy administration", () => {
  let fixture: ResearchFixture;

  beforeAll(() => {
    fixture = new ResearchFixture();
  });

  beforeEach(async () => fixture.reset());

  afterAll(async () => fixture.close());

  it("enforces owner/admin updates, tenant boundaries, optimistic retries, and audit rollback", async () => {
    const owner = await fixture.createActor();
    const viewer = await fixture.createWorkspaceMember(owner, "viewer");
    const admin = await fixture.createWorkspaceMember(owner, "admin");
    const foreign = await fixture.createActor();
    const created = await fixture.execute<{
      createAccessPolicy: {
        code: string;
        id: string | null;
        version: number | null;
      };
    }>({
      jar: owner.jar,
      operationName: "CreateAccessPolicy",
      query: CreateAccessPolicyDocument,
      variables: {
        input: {
          name: "Sensitive policy name",
          resourceKinds: ["person"],
          roleBindings: { owner: ["read"] },
          sensitivityCeiling: "INTERNAL",
          state: "ACTIVE",
        },
      },
    });
    expect(created.body?.errors).toBeUndefined();
    expect(created.body?.data?.createAccessPolicy).toMatchObject({
      code: "APPLIED",
      version: 1,
    });
    const policyId = created.body?.data?.createAccessPolicy.id;
    if (!policyId) throw new Error("Missing created policy ID");

    const requestId = "11111111-1111-4111-8111-111111111111";
    const updated = await fixture.execute<{
      updateAccessPolicy: {
        code: string;
        id: string | null;
        requestId: string;
        version: number | null;
      };
    }>({
      headers: { "x-request-id": requestId },
      jar: owner.jar,
      operationName: "UpdateAccessPolicy",
      query: UpdateAccessPolicyDocument,
      variables: {
        input: {
          expectedVersion: 1,
          id: policyId,
          name: "Updated policy name",
          state: "ACTIVE",
        },
      },
    });
    expect(updated.body?.errors).toBeUndefined();
    expect(updated.body?.data?.updateAccessPolicy).toMatchObject({
      code: "APPLIED",
      id: policyId,
      requestId,
      version: 2,
    });

    const sameRequestRetry = await fixture.execute<{
      updateAccessPolicy: {
        code: string;
        id: string | null;
        version: number | null;
      };
    }>({
      headers: { "x-request-id": requestId },
      jar: owner.jar,
      operationName: "UpdateAccessPolicy",
      query: UpdateAccessPolicyDocument,
      variables: {
        input: {
          expectedVersion: 1,
          id: policyId,
          name: "Updated policy name",
          state: "ACTIVE",
        },
      },
    });
    expect(sameRequestRetry.body?.errors).toBeUndefined();
    expect(sameRequestRetry.body?.data?.updateAccessPolicy).toMatchObject({
      code: "CONFLICT",
      id: null,
      version: null,
    });

    const adminPosture = await fixture.execute<{
      settingsPolicyPosture: { workspace: { version: number } };
    }>({
      jar: admin.jar,
      operationName: "SettingsPolicyPosture",
      query: SettingsPolicyPostureDocument,
    });
    const adminVersion =
      adminPosture.body?.data?.settingsPolicyPosture.workspace.version;
    if (adminVersion == null) throw new Error("Missing admin policy version");
    const adminUpdate = await fixture.execute<{
      updateWorkspaceDefaults: { code: string; version: number | null };
    }>({
      headers: { "x-request-id": "33333333-3333-4333-8333-333333333333" },
      jar: admin.jar,
      operationName: "UpdateWorkspaceDefaults",
      query: UpdateWorkspaceDefaultsDocument,
      variables: {
        input: { expectedVersion: adminVersion, aiEnabled: true },
      },
    });
    expect(adminUpdate.body?.errors).toBeUndefined();
    expect(adminUpdate.body?.data?.updateWorkspaceDefaults).toMatchObject({
      code: "APPLIED",
      version: adminVersion + 1,
    });

    const viewerDenied = await fixture.execute({
      jar: viewer.jar,
      operationName: "UpdateAccessPolicy",
      query: UpdateAccessPolicyDocument,
      variables: {
        input: { expectedVersion: 2, id: policyId, name: "Viewer attempt" },
      },
    });
    expectGraphQLError(viewerDenied, "FORBIDDEN");

    const foreignDenied = await fixture.execute<{
      updateAccessPolicy: { code: string; id: string | null };
    }>({
      jar: foreign.jar,
      operationName: "UpdateAccessPolicy",
      query: UpdateAccessPolicyDocument,
      variables: {
        input: { expectedVersion: 2, id: policyId, name: "Foreign attempt" },
      },
    });
    expect(foreignDenied.body?.errors).toBeUndefined();
    expect(foreignDenied.body?.data?.updateAccessPolicy).toMatchObject({
      code: "CONFLICT",
      id: null,
      version: null,
    });
    expect(JSON.stringify(foreignDenied.body)).not.toContain(policyId);
    expect(JSON.stringify(foreignDenied.body)).not.toContain(
      "Sensitive policy name",
    );

    const staleRetry = await fixture.execute<{
      updateAccessPolicy: {
        code: string;
        id: string | null;
        version: number | null;
      };
    }>({
      headers: { "x-request-id": "22222222-2222-4222-8222-222222222222" },
      jar: owner.jar,
      operationName: "UpdateAccessPolicy",
      query: UpdateAccessPolicyDocument,
      variables: {
        input: { expectedVersion: 1, id: policyId, name: "Retry attempt" },
      },
    });
    expect(staleRetry.body?.errors).toBeUndefined();
    expect(staleRetry.body?.data?.updateAccessPolicy).toMatchObject({
      code: "CONFLICT",
      id: null,
      version: null,
    });

    const invalid = await fixture.execute({
      jar: owner.jar,
      operationName: "UpdateAccessPolicy",
      query: UpdateAccessPolicyDocument,
      variables: {
        input: { expectedVersion: 2, id: policyId, name: "   " },
      },
    });
    expectGraphQLError(invalid, "VALIDATION_FAILED");

    const posture = await fixture.execute<{
      settingsPolicyPosture: {
        accessPolicies: Array<{ id: string; name: string; version: number }>;
      };
    }>({
      jar: owner.jar,
      operationName: "SettingsPolicyPosture",
      query: SettingsPolicyPostureDocument,
    });
    expect(posture.body?.data?.settingsPolicyPosture.accessPolicies).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: policyId,
          name: "Updated policy name",
          version: 2,
        }),
      ]),
    );

    const updates = await fixture.database
      .select({
        action: auditEvents.action,
        redactedDiff: auditEvents.redactedDiff,
        requestId: auditEvents.requestId,
      })
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.workspaceId, owner.workspaceId),
          eq(auditEvents.action, "access_policy.update"),
          eq(auditEvents.resourceId, policyId),
        ),
      );
    expect(updates).toHaveLength(1);
    expect(updates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: "access_policy.update",
          requestId,
          redactedDiff: null,
        }),
      ]),
    );
    expect(JSON.stringify(updates)).not.toContain("Sensitive policy name");
    expect(JSON.stringify(updates)).not.toContain("Updated policy name");
  });

  it("replays policy responses, fences malformed claims, and serializes expiry and concurrency", async () => {
    const owner = await fixture.createActor();
    const created = await fixture.execute<{
      createAccessPolicy: { id: string | null };
    }>({
      jar: owner.jar,
      operationName: "CreateAccessPolicy",
      query: CreateAccessPolicyDocument,
      variables: {
        input: {
          name: "Durable policy",
          resourceKinds: ["person"],
          roleBindings: { owner: ["read"] },
          sensitivityCeiling: "INTERNAL",
          state: "ACTIVE",
        },
      },
    });
    const policyId = created.body?.data?.createAccessPolicy.id;
    if (!policyId) throw new Error("Missing durable policy ID");

    const replayKey = "settings-policy-replay-v1";
    const first = await fixture.execute<{
      updateAccessPolicy: {
        code: string;
        id: string | null;
        requestId: string;
        version: number | null;
      };
    }>({
      headers: { "x-request-id": "44444444-4444-4444-8444-444444444444" },
      jar: owner.jar,
      operationName: "UpdateAccessPolicy",
      query: UpdateAccessPolicyDocument,
      variables: {
        input: {
          expectedVersion: 1,
          id: policyId,
          idempotencyKey: replayKey,
          name: "Durable policy v2",
        },
      },
    });
    expect(first.body?.errors).toBeUndefined();
    expect(first.body?.data?.updateAccessPolicy).toMatchObject({
      code: "APPLIED",
      id: policyId,
      requestId: "44444444-4444-4444-8444-444444444444",
      version: 2,
    });

    const replay = await fixture.execute<{
      updateAccessPolicy: {
        code: string;
        id: string | null;
        requestId: string;
        version: number | null;
      };
    }>({
      headers: { "x-request-id": "55555555-5555-4555-8555-555555555555" },
      jar: owner.jar,
      operationName: "UpdateAccessPolicy",
      query: UpdateAccessPolicyDocument,
      variables: {
        input: {
          expectedVersion: 1,
          id: policyId,
          idempotencyKey: replayKey,
          name: "Durable policy v2",
        },
      },
    });
    expect(replay.body?.errors).toBeUndefined();
    expect(replay.body?.data?.updateAccessPolicy).toEqual(
      first.body?.data?.updateAccessPolicy,
    );

    const [replayClaim] = await fixture.database
      .select({ id: idempotencyKeys.id })
      .from(idempotencyKeys)
      .where(
        and(
          eq(idempotencyKeys.workspaceId, owner.workspaceId),
          eq(idempotencyKeys.operation, "access_policy.update"),
        ),
      )
      .orderBy(sql`${idempotencyKeys.createdAt} desc`)
      .limit(1);
    if (!replayClaim) throw new Error("Missing policy replay claim");
    await fixture.database
      .update(idempotencyKeys)
      .set({ responseReference: { id: ["invalid"] } })
      .where(eq(idempotencyKeys.id, replayClaim.id));
    const malformedReplay = await fixture.execute({
      jar: owner.jar,
      operationName: "UpdateAccessPolicy",
      query: UpdateAccessPolicyDocument,
      variables: {
        input: {
          expectedVersion: 1,
          id: policyId,
          idempotencyKey: replayKey,
          name: "Durable policy v2",
        },
      },
    });
    expectGraphQLError(malformedReplay, "VALIDATION_FAILED");

    const expiryKey = "settings-policy-expiry-v1";
    const expiryFirst = await fixture.execute<{
      updateAccessPolicy: { code: string; version: number | null };
    }>({
      jar: owner.jar,
      operationName: "UpdateAccessPolicy",
      query: UpdateAccessPolicyDocument,
      variables: {
        input: {
          expectedVersion: 2,
          id: policyId,
          idempotencyKey: expiryKey,
          name: "Durable policy expiry seed",
        },
      },
    });
    expect(expiryFirst.body?.data?.updateAccessPolicy).toMatchObject({
      code: "APPLIED",
      version: 3,
    });
    const [expiryClaim] = await fixture.database
      .select({ id: idempotencyKeys.id })
      .from(idempotencyKeys)
      .where(
        and(
          eq(idempotencyKeys.workspaceId, owner.workspaceId),
          eq(idempotencyKeys.operation, "access_policy.update"),
        ),
      )
      .orderBy(sql`${idempotencyKeys.createdAt} desc`)
      .limit(1);
    if (!expiryClaim) throw new Error("Missing policy expiry claim");
    await fixture.database
      .update(idempotencyKeys)
      .set({ expiresAt: new Date(Date.now() - 1_000) })
      .where(eq(idempotencyKeys.id, expiryClaim.id));
    const expiryTakeover = await fixture.execute<{
      updateAccessPolicy: { code: string; version: number | null };
    }>({
      jar: owner.jar,
      operationName: "UpdateAccessPolicy",
      query: UpdateAccessPolicyDocument,
      variables: {
        input: {
          expectedVersion: 3,
          id: policyId,
          idempotencyKey: expiryKey,
          name: "Durable policy expiry takeover",
        },
      },
    });
    expect(expiryTakeover.body?.data?.updateAccessPolicy).toMatchObject({
      code: "APPLIED",
      version: 4,
    });

    const concurrentKey = "settings-policy-concurrent-v1";
    const concurrent = await Promise.all(
      [
        "66666666-6666-4666-8666-666666666666",
        "77777777-7777-4777-8777-777777777777",
      ].map((requestId) =>
        fixture.execute<{
          updateAccessPolicy: {
            code: string;
            id: string | null;
            requestId: string;
            version: number | null;
          };
        }>({
          headers: { "x-request-id": requestId },
          jar: owner.jar,
          operationName: "UpdateAccessPolicy",
          query: UpdateAccessPolicyDocument,
          variables: {
            input: {
              expectedVersion: 4,
              id: policyId,
              idempotencyKey: concurrentKey,
              name: "Durable policy concurrent",
            },
          },
        }),
      ),
    );
    expect(concurrent.every((result) => !result.body?.errors)).toBe(true);
    expect(concurrent[0]?.body?.data?.updateAccessPolicy).toEqual(
      concurrent[1]?.body?.data?.updateAccessPolicy,
    );
    expect(concurrent[0]?.body?.data?.updateAccessPolicy).toMatchObject({
      code: "APPLIED",
      id: policyId,
      version: 5,
    });
    const [auditCount] = await fixture.database
      .select({ count: sql<number>`count(*)` })
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.workspaceId, owner.workspaceId),
          eq(auditEvents.action, "access_policy.update"),
          eq(auditEvents.resourceId, policyId),
        ),
      );
    expect(Number(auditCount?.count)).toBe(4);

    const foreign = await fixture.createActor();
    const foreignCreated = await fixture.execute<{
      createAccessPolicy: { id: string | null };
    }>({
      jar: foreign.jar,
      operationName: "CreateAccessPolicy",
      query: CreateAccessPolicyDocument,
      variables: {
        input: {
          name: "Foreign durable policy",
          resourceKinds: ["person"],
          roleBindings: { owner: ["read"] },
          sensitivityCeiling: "INTERNAL",
          state: "ACTIVE",
        },
      },
    });
    const foreignPolicyId = foreignCreated.body?.data?.createAccessPolicy.id;
    if (!foreignPolicyId) throw new Error("Missing foreign policy ID");
    const foreignUpdate = await fixture.execute<{
      updateAccessPolicy: {
        code: string;
        id: string | null;
        version: number | null;
      };
    }>({
      jar: foreign.jar,
      operationName: "UpdateAccessPolicy",
      query: UpdateAccessPolicyDocument,
      variables: {
        input: {
          expectedVersion: 1,
          id: foreignPolicyId,
          idempotencyKey: replayKey,
          name: "Foreign durable policy v2",
        },
      },
    });
    expect(foreignUpdate.body?.errors).toBeUndefined();
    expect(foreignUpdate.body?.data?.updateAccessPolicy).toMatchObject({
      code: "APPLIED",
      id: foreignPolicyId,
      version: 2,
    });
    const [foreignClaims] = await fixture.database
      .select({ count: sql<number>`count(*)` })
      .from(idempotencyKeys)
      .where(
        and(
          eq(idempotencyKeys.workspaceId, foreign.workspaceId),
          eq(idempotencyKeys.operation, "access_policy.update"),
        ),
      );
    expect(Number(foreignClaims?.count)).toBe(1);
  });
});
