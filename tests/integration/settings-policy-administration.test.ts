// @vitest-environment node

import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { newId } from "@/db/id";
import {
  ArchiveAccessPolicyDocument,
  ArchiveResourceGrantDocument,
  CreateConsentRecordDocument,
  CreateDeletionRequestDocument,
  CreateLegalHoldDocument,
  CreateAccessPolicyDocument,
  CreateResourceGrantDocument,
  CreatePersonDocument,
  ReleaseLegalHoldDocument,
  ReviewDeletionRequestDocument,
  SettingsPolicyPostureDocument,
  UpsertRetentionPolicyDocument,
  UpdateAccessPolicyDocument,
  UpdateResourceGrantDocument,
  UpdateWorkspaceDefaultsDocument,
} from "@/graphql/generated/graphql";
import { auditEvents, idempotencyKeys } from "@/db/schema/operations";
import { consentRecords, deletionRequests } from "@/db/schema/privacy";
import {
  accessPolicies,
  legalHolds,
  resourceGrants,
  retentionPolicies,
} from "@/db/schema/workspaces";

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

  it("replays policy and resource-grant creation, updates, and archives", async () => {
    const owner = await fixture.createActor();
    const policyInput = {
      idempotencyKey: "policy-create-replay-v1",
      name: "Durable grant policy",
      resourceKinds: ["person"],
      roleBindings: { owner: ["read"] },
      sensitivityCeiling: "INTERNAL" as const,
      state: "ACTIVE" as const,
    };
    const policyRequests = await Promise.all(
      [
        "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      ].map((requestId) =>
        fixture.execute<{
          createAccessPolicy: {
            code: string;
            id: string | null;
            requestId: string;
            version: number | null;
          };
        }>({
          headers: { "x-request-id": requestId },
          jar: owner.jar,
          operationName: "CreateAccessPolicy",
          query: CreateAccessPolicyDocument,
          variables: { input: policyInput },
        }),
      ),
    );
    expect(policyRequests.every((result) => !result.body?.errors)).toBe(true);
    expect(policyRequests[0]?.body?.data?.createAccessPolicy).toEqual(
      policyRequests[1]?.body?.data?.createAccessPolicy,
    );
    const policyResult = policyRequests[0]?.body?.data?.createAccessPolicy;
    if (!policyResult?.id) throw new Error("Missing policy replay result");
    expect(policyResult).toMatchObject({ code: "APPLIED", version: 1 });
    expect(
      await fixture.database
        .select({ id: accessPolicies.id })
        .from(accessPolicies)
        .where(eq(accessPolicies.workspaceId, owner.workspaceId)),
    ).toHaveLength(1);

    const resourceId = newId();
    const grantInput = {
      idempotencyKey: "grant-create-replay-v1",
      policyId: policyResult.id,
      resourceId,
      resourceKind: "person",
      role: "VIEWER" as const,
    };
    const grantRequests = await Promise.all(
      [
        "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      ].map((requestId) =>
        fixture.execute<{
          createResourceGrant: {
            code: string;
            id: string | null;
            requestId: string;
            version: number | null;
          };
        }>({
          headers: { "x-request-id": requestId },
          jar: owner.jar,
          operationName: "CreateResourceGrant",
          query: CreateResourceGrantDocument,
          variables: { input: grantInput },
        }),
      ),
    );
    expect(grantRequests.every((result) => !result.body?.errors)).toBe(true);
    expect(grantRequests[0]?.body?.data?.createResourceGrant).toEqual(
      grantRequests[1]?.body?.data?.createResourceGrant,
    );
    const grantResult = grantRequests[0]?.body?.data?.createResourceGrant;
    if (!grantResult?.id) throw new Error("Missing grant replay result");
    expect(grantResult).toMatchObject({ code: "APPLIED", version: 1 });
    expect(
      await fixture.database
        .select({ id: resourceGrants.id })
        .from(resourceGrants)
        .where(eq(resourceGrants.workspaceId, owner.workspaceId)),
    ).toHaveLength(1);

    const updateInput = {
      expectedVersion: 1,
      id: grantResult.id,
      idempotencyKey: "grant-update-replay-v1",
      validUntil: "2030-01-01T00:00:00.000Z",
    };
    const updated = await fixture.execute<{
      updateResourceGrant: {
        code: string;
        id: string | null;
        version: number | null;
      };
    }>({
      jar: owner.jar,
      operationName: "UpdateResourceGrant",
      query: UpdateResourceGrantDocument,
      variables: { input: updateInput },
    });
    const replayedUpdate = await fixture.execute<{
      updateResourceGrant: {
        code: string;
        id: string | null;
        version: number | null;
      };
    }>({
      jar: owner.jar,
      operationName: "UpdateResourceGrant",
      query: UpdateResourceGrantDocument,
      variables: { input: updateInput },
    });
    expect(updated.body?.errors).toBeUndefined();
    expect(replayedUpdate.body?.errors).toBeUndefined();
    expect(updated.body?.data?.updateResourceGrant).toMatchObject({
      code: "APPLIED",
      id: grantResult.id,
      version: 2,
    });
    expect(replayedUpdate.body?.data?.updateResourceGrant).toEqual(
      updated.body?.data?.updateResourceGrant,
    );

    const [updateClaim] = await fixture.database
      .select()
      .from(idempotencyKeys)
      .where(
        and(
          eq(idempotencyKeys.workspaceId, owner.workspaceId),
          eq(idempotencyKeys.operation, "resource_grant.update"),
        ),
      );
    if (!updateClaim) throw new Error("Missing resource-grant update claim");
    await fixture.database
      .update(idempotencyKeys)
      .set({ responseReference: { id: ["invalid"] } })
      .where(eq(idempotencyKeys.id, updateClaim.id));
    expectGraphQLError(
      await fixture.execute({
        jar: owner.jar,
        operationName: "UpdateResourceGrant",
        query: UpdateResourceGrantDocument,
        variables: { input: updateInput },
      }),
      "VALIDATION_FAILED",
    );

    await fixture.database
      .update(idempotencyKeys)
      .set({
        responseReference: {
          code: "APPLIED",
          id: grantResult.id,
          requestId: "replayed-update-request",
          version: 2,
        },
        expiresAt: new Date(Date.now() - 1_000),
      })
      .where(eq(idempotencyKeys.id, updateClaim.id));
    const takeover = await fixture.execute<{
      updateResourceGrant: { code: string; version: number | null };
    }>({
      jar: owner.jar,
      operationName: "UpdateResourceGrant",
      query: UpdateResourceGrantDocument,
      variables: { input: { ...updateInput, expectedVersion: 2 } },
    });
    expect(takeover.body?.errors).toBeUndefined();
    expect(takeover.body?.data?.updateResourceGrant).toMatchObject({
      code: "APPLIED",
      version: 3,
    });

    const archivedGrant = await fixture.execute<{
      archiveResourceGrant: {
        code: string;
        id: string | null;
        version: number | null;
      };
    }>({
      jar: owner.jar,
      operationName: "ArchiveResourceGrant",
      query: ArchiveResourceGrantDocument,
      variables: {
        expectedVersion: 3,
        id: grantResult.id,
        idempotencyKey: "grant-archive-replay-v1",
      },
    });
    const replayedArchivedGrant = await fixture.execute<{
      archiveResourceGrant: {
        code: string;
        id: string | null;
        version: number | null;
      };
    }>({
      jar: owner.jar,
      operationName: "ArchiveResourceGrant",
      query: ArchiveResourceGrantDocument,
      variables: {
        expectedVersion: 3,
        id: grantResult.id,
        idempotencyKey: "grant-archive-replay-v1",
      },
    });
    expect(archivedGrant.body?.errors).toBeUndefined();
    expect(replayedArchivedGrant.body?.errors).toBeUndefined();
    expect(replayedArchivedGrant.body?.data?.archiveResourceGrant).toEqual(
      archivedGrant.body?.data?.archiveResourceGrant,
    );
    expect(archivedGrant.body?.data?.archiveResourceGrant).toMatchObject({
      code: "APPLIED",
      id: grantResult.id,
      version: 4,
    });

    const archivedPolicy = await fixture.execute<{
      archiveAccessPolicy: {
        code: string;
        id: string | null;
        version: number | null;
      };
    }>({
      jar: owner.jar,
      operationName: "ArchiveAccessPolicy",
      query: ArchiveAccessPolicyDocument,
      variables: {
        expectedVersion: 1,
        id: policyResult.id,
        idempotencyKey: "policy-archive-replay-v1",
      },
    });
    expect(archivedPolicy.body?.errors).toBeUndefined();
    expect(archivedPolicy.body?.data?.archiveAccessPolicy).toMatchObject({
      code: "APPLIED",
      id: policyResult.id,
      version: 2,
    });

    const [grantAuditCount] = await fixture.database
      .select({ count: sql<number>`count(*)` })
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.workspaceId, owner.workspaceId),
          eq(auditEvents.resourceKind, "resource_grant"),
          eq(auditEvents.resourceId, grantResult.id),
        ),
      );
    expect(Number(grantAuditCount?.count)).toBe(4);

    const foreign = await fixture.createActor();
    const foreignPolicy = await fixture.execute<{
      createAccessPolicy: { id: string | null };
    }>({
      jar: foreign.jar,
      operationName: "CreateAccessPolicy",
      query: CreateAccessPolicyDocument,
      variables: {
        input: { ...policyInput, name: "Foreign policy" },
      },
    });
    expect(foreignPolicy.body?.errors).toBeUndefined();
    expect(foreignPolicy.body?.data?.createAccessPolicy.id).not.toBe(
      policyResult.id,
    );
    const [foreignClaimCount] = await fixture.database
      .select({ count: sql<number>`count(*)` })
      .from(idempotencyKeys)
      .where(
        and(
          eq(idempotencyKeys.workspaceId, foreign.workspaceId),
          eq(idempotencyKeys.operation, "access_policy.create"),
        ),
      );
    expect(Number(foreignClaimCount?.count)).toBe(1);
  });

  it("replays workspace defaults, fences malformed and expired claims, and isolates tenants", async () => {
    const owner = await fixture.createActor();
    const viewer = await fixture.createWorkspaceMember(owner, "viewer");
    const posture = await fixture.execute<{
      settingsPolicyPosture: { workspace: { version: number } };
    }>({
      jar: owner.jar,
      operationName: "SettingsPolicyPosture",
      query: SettingsPolicyPostureDocument,
    });
    const initialVersion =
      posture.body?.data?.settingsPolicyPosture.workspace.version;
    if (initialVersion == null) throw new Error("Missing workspace version");

    const replayInput = {
      aiEnabled: true,
      expectedVersion: initialVersion,
      idempotencyKey: "workspace-defaults-replay-v1",
    };
    const first = await fixture.execute<{
      updateWorkspaceDefaults: {
        code: string;
        id: string | null;
        requestId: string;
        version: number | null;
      };
    }>({
      headers: { "x-request-id": "88888888-8888-4888-8888-888888888888" },
      jar: owner.jar,
      operationName: "UpdateWorkspaceDefaults",
      query: UpdateWorkspaceDefaultsDocument,
      variables: { input: replayInput },
    });
    expect(first.body?.errors).toBeUndefined();
    const firstResult = first.body?.data?.updateWorkspaceDefaults;
    expect(firstResult).toMatchObject({
      code: "APPLIED",
      requestId: "88888888-8888-4888-8888-888888888888",
      version: initialVersion + 1,
    });

    const replay = await fixture.execute<{
      updateWorkspaceDefaults: {
        code: string;
        id: string | null;
        requestId: string;
        version: number | null;
      };
    }>({
      headers: { "x-request-id": "99999999-9999-4999-8999-999999999999" },
      jar: owner.jar,
      operationName: "UpdateWorkspaceDefaults",
      query: UpdateWorkspaceDefaultsDocument,
      variables: { input: replayInput },
    });
    expect(replay.body?.errors).toBeUndefined();
    expect(replay.body?.data?.updateWorkspaceDefaults).toEqual(firstResult);
    expectGraphQLError(
      await fixture.execute({
        jar: owner.jar,
        operationName: "UpdateWorkspaceDefaults",
        query: UpdateWorkspaceDefaultsDocument,
        variables: {
          input: {
            expectedVersion: initialVersion,
            idempotencyKey: replayInput.idempotencyKey,
            timezone: "UTC",
          },
        },
      }),
      "CONFLICT",
    );

    const [replayClaim] = await fixture.database
      .select({ id: idempotencyKeys.id })
      .from(idempotencyKeys)
      .where(
        and(
          eq(idempotencyKeys.workspaceId, owner.workspaceId),
          eq(idempotencyKeys.operation, "workspace.defaults.update"),
        ),
      )
      .limit(1);
    if (!replayClaim) throw new Error("Missing workspace defaults claim");
    await fixture.database
      .update(idempotencyKeys)
      .set({ responseReference: { id: ["invalid"] } })
      .where(eq(idempotencyKeys.id, replayClaim.id));
    expectGraphQLError(
      await fixture.execute({
        jar: owner.jar,
        operationName: "UpdateWorkspaceDefaults",
        query: UpdateWorkspaceDefaultsDocument,
        variables: { input: replayInput },
      }),
      "VALIDATION_FAILED",
    );
    await fixture.database
      .update(idempotencyKeys)
      .set({ responseReference: firstResult })
      .where(eq(idempotencyKeys.id, replayClaim.id));

    const expiryPosture = await fixture.execute<{
      settingsPolicyPosture: { workspace: { version: number } };
    }>({
      jar: owner.jar,
      operationName: "SettingsPolicyPosture",
      query: SettingsPolicyPostureDocument,
    });
    const expiryVersion =
      expiryPosture.body?.data?.settingsPolicyPosture.workspace.version;
    if (expiryVersion == null) throw new Error("Missing expiry version");
    const expiryKey = "workspace-defaults-expiry-v1";
    const expiryFirst = await fixture.execute<{
      updateWorkspaceDefaults: { code: string; version: number | null };
    }>({
      jar: owner.jar,
      operationName: "UpdateWorkspaceDefaults",
      query: UpdateWorkspaceDefaultsDocument,
      variables: {
        input: {
          expectedVersion: expiryVersion,
          idempotencyKey: expiryKey,
          timezone: "UTC",
        },
      },
    });
    expect(expiryFirst.body?.data?.updateWorkspaceDefaults).toMatchObject({
      code: "APPLIED",
      version: expiryVersion + 1,
    });
    const [expiryClaim] = await fixture.database
      .select({ id: idempotencyKeys.id })
      .from(idempotencyKeys)
      .where(
        and(
          eq(idempotencyKeys.workspaceId, owner.workspaceId),
          eq(idempotencyKeys.operation, "workspace.defaults.update"),
        ),
      )
      .orderBy(sql`${idempotencyKeys.createdAt} desc`)
      .limit(1);
    if (!expiryClaim) throw new Error("Missing expiry claim");
    await fixture.database
      .update(idempotencyKeys)
      .set({ expiresAt: new Date(Date.now() - 1_000) })
      .where(eq(idempotencyKeys.id, expiryClaim.id));
    const expiryTakeover = await fixture.execute<{
      updateWorkspaceDefaults: { code: string; version: number | null };
    }>({
      jar: owner.jar,
      operationName: "UpdateWorkspaceDefaults",
      query: UpdateWorkspaceDefaultsDocument,
      variables: {
        input: {
          expectedVersion: expiryVersion + 1,
          idempotencyKey: expiryKey,
          locale: "en-US",
        },
      },
    });
    expect(expiryTakeover.body?.data?.updateWorkspaceDefaults).toMatchObject({
      code: "APPLIED",
      version: expiryVersion + 2,
    });

    const concurrentPosture = await fixture.execute<{
      settingsPolicyPosture: { workspace: { version: number } };
    }>({
      jar: owner.jar,
      operationName: "SettingsPolicyPosture",
      query: SettingsPolicyPostureDocument,
    });
    const concurrentVersion =
      concurrentPosture.body?.data?.settingsPolicyPosture.workspace.version;
    if (concurrentVersion == null)
      throw new Error("Missing concurrent version");
    const concurrent = await Promise.all(
      [
        "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      ].map((requestId) =>
        fixture.execute<{
          updateWorkspaceDefaults: {
            code: string;
            id: string | null;
            requestId: string;
            version: number | null;
          };
        }>({
          headers: { "x-request-id": requestId },
          jar: owner.jar,
          operationName: "UpdateWorkspaceDefaults",
          query: UpdateWorkspaceDefaultsDocument,
          variables: {
            input: {
              expectedVersion: concurrentVersion,
              idempotencyKey: "workspace-defaults-concurrent-v1",
              retentionDays: 365,
            },
          },
        }),
      ),
    );
    expect(concurrent.every((result) => !result.body?.errors)).toBe(true);
    expect(concurrent[0]?.body?.data?.updateWorkspaceDefaults).toEqual(
      concurrent[1]?.body?.data?.updateWorkspaceDefaults,
    );
    expect(concurrent[0]?.body?.data?.updateWorkspaceDefaults).toMatchObject({
      code: "APPLIED",
      version: concurrentVersion + 1,
    });

    const [auditCount] = await fixture.database
      .select({ count: sql<number>`count(*)` })
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.workspaceId, owner.workspaceId),
          eq(auditEvents.action, "workspace.policy.update"),
        ),
      );
    expect(Number(auditCount?.count)).toBe(4);

    expectGraphQLError(
      await fixture.execute({
        jar: viewer.jar,
        operationName: "UpdateWorkspaceDefaults",
        query: UpdateWorkspaceDefaultsDocument,
        variables: {
          input: {
            expectedVersion: concurrentVersion + 1,
            idempotencyKey: "viewer-workspace-defaults",
            aiEnabled: false,
          },
        },
      }),
      "FORBIDDEN",
    );

    const foreign = await fixture.createActor();
    const foreignPosture = await fixture.execute<{
      settingsPolicyPosture: { workspace: { version: number } };
    }>({
      jar: foreign.jar,
      operationName: "SettingsPolicyPosture",
      query: SettingsPolicyPostureDocument,
    });
    const foreignVersion =
      foreignPosture.body?.data?.settingsPolicyPosture.workspace.version;
    if (foreignVersion == null) throw new Error("Missing foreign version");
    const foreignUpdate = await fixture.execute<{
      updateWorkspaceDefaults: { code: string; version: number | null };
    }>({
      jar: foreign.jar,
      operationName: "UpdateWorkspaceDefaults",
      query: UpdateWorkspaceDefaultsDocument,
      variables: {
        input: {
          aiEnabled: true,
          expectedVersion: foreignVersion,
          idempotencyKey: replayInput.idempotencyKey,
        },
      },
    });
    expect(foreignUpdate.body?.data?.updateWorkspaceDefaults).toMatchObject({
      code: "APPLIED",
      version: foreignVersion + 1,
    });
    const [foreignClaims] = await fixture.database
      .select({ count: sql<number>`count(*)` })
      .from(idempotencyKeys)
      .where(
        and(
          eq(idempotencyKeys.workspaceId, foreign.workspaceId),
          eq(idempotencyKeys.operation, "workspace.defaults.update"),
        ),
      );
    expect(Number(foreignClaims?.count)).toBe(1);
  });

  it("replays and fences privacy settings mutations with durable response references", async () => {
    const owner = await fixture.createActor();
    const person = await fixture.execute<{
      createPerson: { person: { id: string } | null };
    }>({
      jar: owner.jar,
      operationName: "CreatePerson",
      query: CreatePersonDocument,
      variables: { input: { displayName: "Privacy idempotency subject" } },
    });
    const personId = person.body?.data?.createPerson.person?.id;
    if (!personId) throw new Error("Missing privacy test person");

    const retentionInput = {
      deletionBehavior: "REVIEW",
      idempotencyKey: "privacy-retention-replay-v1",
      legalBasis: "research",
      resourceKind: "person",
      retentionDays: 365,
    };
    const retention = await fixture.execute<{
      upsertRetentionPolicy: {
        code: string;
        id: string | null;
        version: number | null;
      };
    }>({
      jar: owner.jar,
      operationName: "UpsertRetentionPolicy",
      query: UpsertRetentionPolicyDocument,
      variables: { input: retentionInput },
    });
    const retentionResult = retention.body?.data?.upsertRetentionPolicy;
    expect(retention.body?.errors).toBeUndefined();
    expect(retentionResult).toMatchObject({ code: "APPLIED", version: 1 });
    const retentionReplay = await fixture.execute({
      jar: owner.jar,
      operationName: "UpsertRetentionPolicy",
      query: UpsertRetentionPolicyDocument,
      variables: { input: retentionInput },
    });
    expect(retentionReplay.body?.data?.upsertRetentionPolicy).toEqual(
      retentionResult,
    );
    const [retentionCount] = await fixture.database
      .select({ count: sql<number>`count(*)` })
      .from(retentionPolicies)
      .where(eq(retentionPolicies.workspaceId, owner.workspaceId));
    expect(Number(retentionCount?.count)).toBe(1);

    const [retentionClaim] = await fixture.database
      .select({ id: idempotencyKeys.id })
      .from(idempotencyKeys)
      .where(
        and(
          eq(idempotencyKeys.workspaceId, owner.workspaceId),
          eq(idempotencyKeys.operation, "retention_policy.upsert"),
        ),
      );
    if (!retentionClaim) throw new Error("Missing retention claim");
    await fixture.database
      .update(idempotencyKeys)
      .set({ responseReference: { id: ["malformed"] } })
      .where(eq(idempotencyKeys.id, retentionClaim.id));
    expectGraphQLError(
      await fixture.execute({
        jar: owner.jar,
        operationName: "UpsertRetentionPolicy",
        query: UpsertRetentionPolicyDocument,
        variables: { input: retentionInput },
      }),
      "VALIDATION_FAILED",
    );

    const holdInput = {
      authority: "privacy officer",
      idempotencyKey: "privacy-hold-create-v1",
      reason: "Investigation",
      resourceId: personId,
      resourceKind: "person",
    };
    const hold = await fixture.execute<{
      createLegalHold: {
        code: string;
        id: string | null;
        version: number | null;
      };
    }>({
      jar: owner.jar,
      operationName: "CreateLegalHold",
      query: CreateLegalHoldDocument,
      variables: { input: holdInput },
    });
    const holdResult = hold.body?.data?.createLegalHold;
    expect(holdResult).toMatchObject({ code: "APPLIED", version: 1 });
    const holdReplay = await fixture.execute({
      jar: owner.jar,
      operationName: "CreateLegalHold",
      query: CreateLegalHoldDocument,
      variables: { input: holdInput },
    });
    expect(holdReplay.body?.data?.createLegalHold).toEqual(holdResult);
    const [holdCount] = await fixture.database
      .select({ count: sql<number>`count(*)` })
      .from(legalHolds)
      .where(eq(legalHolds.workspaceId, owner.workspaceId));
    expect(Number(holdCount?.count)).toBe(1);
    const holdId = holdResult?.id;
    if (!holdId) throw new Error("Missing legal hold ID");
    const releaseInput = {
      expectedVersion: 1,
      id: holdId,
      idempotencyKey: "privacy-hold-release-v1",
      releaseReason: "Investigation closed",
    };
    const released = await fixture.execute<{
      releaseLegalHold: {
        code: string;
        id: string | null;
        version: number | null;
      };
    }>({
      jar: owner.jar,
      operationName: "ReleaseLegalHold",
      query: ReleaseLegalHoldDocument,
      variables: { input: releaseInput },
    });
    const releaseResult = released.body?.data?.releaseLegalHold;
    expect(releaseResult).toMatchObject({
      code: "APPLIED",
      id: holdId,
      version: 2,
    });
    const releaseReplay = await fixture.execute({
      jar: owner.jar,
      operationName: "ReleaseLegalHold",
      query: ReleaseLegalHoldDocument,
      variables: { input: releaseInput },
    });
    expect(releaseReplay.body?.data?.releaseLegalHold).toEqual(releaseResult);

    const consentIdempotencyKey = ["consent", "case", "001"].join("-");
    const consentInput = {
      effectiveFrom: "2026-01-01T00:00:00.000Z",
      idempotencyKey: consentIdempotencyKey,
      personId,
      purpose: "research",
      source: "signed form",
      status: "GRANTED",
    };
    const consent = await fixture.execute<{
      createConsentRecord: {
        code: string;
        id: string | null;
        version: number | null;
      };
    }>({
      jar: owner.jar,
      operationName: "CreateConsentRecord",
      query: CreateConsentRecordDocument,
      variables: { input: consentInput },
    });
    const consentResult = consent.body?.data?.createConsentRecord;
    expect(consentResult).toMatchObject({ code: "APPLIED", version: 1 });
    const consentConcurrent = await Promise.all(
      Array.from({ length: 2 }, () =>
        fixture.execute({
          jar: owner.jar,
          operationName: "CreateConsentRecord",
          query: CreateConsentRecordDocument,
          variables: {
            input: {
              ...consentInput,
              idempotencyKey: "privacy-consent-concurrent-v1",
              purpose: "concurrent research",
            },
          },
        }),
      ),
    );
    expect(consentConcurrent.every((result) => !result.body?.errors)).toBe(
      true,
    );
    expect(consentConcurrent[0]?.body?.data?.createConsentRecord).toEqual(
      consentConcurrent[1]?.body?.data?.createConsentRecord,
    );
    const [consentCount] = await fixture.database
      .select({ count: sql<number>`count(*)` })
      .from(consentRecords)
      .where(eq(consentRecords.workspaceId, owner.workspaceId));
    expect(Number(consentCount?.count)).toBe(2);

    const deletionInput = {
      idempotencyKey: "privacy-deletion-create-v1",
      scope: { personIds: [personId] },
    };
    const deletion = await fixture.execute<{
      createDeletionRequest: {
        code: string;
        id: string | null;
        version: number | null;
      };
    }>({
      jar: owner.jar,
      operationName: "CreateDeletionRequest",
      query: CreateDeletionRequestDocument,
      variables: { input: deletionInput },
    });
    const deletionResult = deletion.body?.data?.createDeletionRequest;
    expect(deletionResult).toMatchObject({ code: "APPLIED", version: 1 });
    const deletionReplay = await fixture.execute({
      jar: owner.jar,
      operationName: "CreateDeletionRequest",
      query: CreateDeletionRequestDocument,
      variables: { input: deletionInput },
    });
    expect(deletionReplay.body?.data?.createDeletionRequest).toEqual(
      deletionResult,
    );
    const [deletionCount] = await fixture.database
      .select({ count: sql<number>`count(*)` })
      .from(deletionRequests)
      .where(eq(deletionRequests.workspaceId, owner.workspaceId));
    expect(Number(deletionCount?.count)).toBe(1);
    const deletionId = deletionResult?.id;
    if (!deletionId) throw new Error("Missing deletion request ID");
    const reviewInput = {
      expectedVersion: 1,
      id: deletionId,
      idempotencyKey: "privacy-deletion-review-v1",
      notes: "Approved by privacy officer",
      state: "APPROVED",
    };
    const reviewed = await fixture.execute<{
      reviewDeletionRequest: {
        code: string;
        id: string | null;
        version: number | null;
      };
    }>({
      jar: owner.jar,
      operationName: "ReviewDeletionRequest",
      query: ReviewDeletionRequestDocument,
      variables: { input: reviewInput },
    });
    const reviewResult = reviewed.body?.data?.reviewDeletionRequest;
    expect(reviewResult).toMatchObject({
      code: "APPLIED",
      id: deletionId,
      version: 2,
    });
    const reviewReplay = await fixture.execute({
      jar: owner.jar,
      operationName: "ReviewDeletionRequest",
      query: ReviewDeletionRequestDocument,
      variables: { input: reviewInput },
    });
    expect(reviewReplay.body?.data?.reviewDeletionRequest).toEqual(
      reviewResult,
    );

    const foreign = await fixture.createActor();
    const foreignRetention = await fixture.execute({
      jar: foreign.jar,
      operationName: "UpsertRetentionPolicy",
      query: UpsertRetentionPolicyDocument,
      variables: {
        input: {
          ...retentionInput,
          idempotencyKey: "privacy-retention-replay-v1",
          resourceKind: "evidence",
        },
      },
    });
    expect(foreignRetention.body?.errors).toBeUndefined();
    expect(foreignRetention.body?.data?.upsertRetentionPolicy).toMatchObject({
      code: "APPLIED",
      version: 1,
    });
  });
});
