// @vitest-environment node

import { and, eq, sql } from "drizzle-orm";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { newId } from "@/db/id";
import {
  ArchiveAccessPolicyDocument,
  ArchiveResourceGrantDocument,
  CreateConsentRecordDocument,
  CreateDeletionRequestDocument,
  CreateGovernedDeletionRequestFromSettingsDocument,
  CreateLegalHoldDocument,
  CreateAccessPolicyDocument,
  CreateResourceGrantDocument,
  CreatePersonDocument,
  ReleaseLegalHoldDocument,
  ReviewDeletionRequestDocument,
  ReviewGovernedDeletionRequestFromSettingsDocument,
  FulfillGovernedDeletionRequestFromSettingsDocument,
  SettingsPolicyPostureDocument,
  UpsertRetentionPolicyDocument,
  UpdateAccessPolicyDocument,
  UpdateResourceGrantDocument,
  UpdateWorkspaceDefaultsDocument,
} from "@/graphql/generated/graphql";
import { auditEvents, idempotencyKeys, jobs } from "@/db/schema/operations";
import {
  aiEphemeralInputs,
  aiMessages,
  aiReviewSuggestions,
  aiRuns,
  aiThreads,
} from "@/db/schema/ai";
import { files } from "@/db/schema/files";
import { people } from "@/db/schema/people";
import {
  personWebResearchRuns,
  personWebResearchSources,
} from "@/db/schema/person-research";
import {
  consentRecords,
  deletionRequests,
  privacyProcessorPropagations,
  privacyRequests,
} from "@/db/schema/privacy";
import {
  accessPolicies,
  legalHolds,
  resourceGrants,
  retentionPolicies,
} from "@/db/schema/workspaces";
import { executeApprovedDeletionRequests } from "@/modules/privacy/deletion-executor";

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

  async function startGovernedDeletion(
    owner: Awaited<ReturnType<ResearchFixture["createActor"]>>,
    scope: { personIds?: string[]; fileIds?: string[] },
    idempotencyKey: string,
  ): Promise<string> {
    const reviewer = await fixture.createWorkspaceMember(owner, "admin");
    const evidenceId = newId();
    await fixture.database.insert(files).values({
      id: evidenceId,
      workspaceId: owner.workspaceId,
      storageProvider: "s3",
      storageBucket: "test",
      storageKey: `privacy-verification/${evidenceId}`,
      originalName: "privacy-verification.txt",
      byteSize: 1,
      checksum: "a".repeat(64),
      quarantineState: "available",
      scanState: "clean",
      uploadedBy: owner.userId,
      createdBy: owner.principalId,
      updatedBy: owner.principalId,
    });
    const created = await fixture.execute<{
      createPrivacyRequest: { id: string; version: number };
    }>({
      jar: owner.jar,
      operationName: "CreateGovernedDeletionRequestFromSettings",
      query: CreateGovernedDeletionRequestFromSettingsDocument,
      variables: {
        input: {
          ...scope,
          dueAt: new Date(Date.now() + 86_400_000).toISOString(),
          idempotencyKey,
          requestType: "DELETION",
        },
      },
    });
    expect(created.body?.errors).toBeUndefined();
    const request = created.body?.data?.createPrivacyRequest;
    if (!request) throw new Error("Missing governed privacy request");
    const reviewed = await fixture.execute<{
      reviewPrivacyRequest: { id: string; version: number };
    }>({
      jar: reviewer.jar,
      operationName: "ReviewGovernedDeletionRequestFromSettings",
      query: ReviewGovernedDeletionRequestFromSettingsDocument,
      variables: {
        expectedVersion: request.version,
        id: request.id,
        idempotencyKey: `${idempotencyKey}-review`,
        state: "APPROVED",
        verificationEvidenceId: evidenceId,
      },
    });
    expect(reviewed.body?.errors).toBeUndefined();
    const approved = reviewed.body?.data?.reviewPrivacyRequest;
    if (!approved) throw new Error("Missing governed privacy review");
    const fulfilled = await fixture.execute({
      jar: reviewer.jar,
      operationName: "FulfillGovernedDeletionRequestFromSettings",
      query: FulfillGovernedDeletionRequestFromSettingsDocument,
      variables: {
        expectedVersion: approved.version,
        id: request.id,
        idempotencyKey: `${idempotencyKey}-fulfill`,
      },
    });
    expect(fulfilled.body?.errors).toBeUndefined();
    const [governed] = await fixture.database
      .select({
        legacyDeletionRequestId: privacyRequests.legacyDeletionRequestId,
      })
      .from(privacyRequests)
      .where(eq(privacyRequests.id, request.id));
    if (!governed?.legacyDeletionRequestId)
      throw new Error("Missing governed deletion queue row");
    return governed.legacyDeletionRequestId;
  }

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
    const reviewer = await fixture.createWorkspaceMember(owner, "admin");
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
      jar: reviewer.jar,
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
      jar: reviewer.jar,
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

  it("fails closed for every legacy deletion transition and foreign scope", async () => {
    const owner = await fixture.createActor();
    const foreign = await fixture.createActor();
    const foreignPerson = await fixture.execute<{
      createPerson: { person: { id: string } | null };
    }>({
      jar: foreign.jar,
      operationName: "CreatePerson",
      query: CreatePersonDocument,
      variables: { input: { displayName: "Foreign deletion subject" } },
    });
    const foreignPersonId = foreignPerson.body?.data?.createPerson.person?.id;
    if (!foreignPersonId) throw new Error("Missing foreign deletion subject");

    expectGraphQLError(
      await fixture.execute({
        jar: owner.jar,
        operationName: "CreateDeletionRequest",
        query: CreateDeletionRequestDocument,
        variables: {
          input: {
            idempotencyKey: "deprecated-foreign-deletion",
            scope: { personIds: [foreignPersonId] },
          },
        },
      }),
      "PRECONDITION_FAILED",
    );

    for (const state of ["APPROVED", "DELETING", "COMPLETED"] as const) {
      const id = newId();
      await fixture.database.insert(deletionRequests).values({
        id,
        workspaceId: owner.workspaceId,
        requesterId: owner.userId,
        scope: { personIds: [], fileIds: [] },
        createdBy: owner.userId,
        updatedBy: owner.userId,
      });
      expectGraphQLError(
        await fixture.execute({
          jar: owner.jar,
          operationName: "ReviewDeletionRequest",
          query: ReviewDeletionRequestDocument,
          variables: {
            input: {
              expectedVersion: 1,
              id,
              idempotencyKey: `deprecated-${state.toLowerCase()}-deletion`,
              state,
            },
          },
        }),
        "PRECONDITION_FAILED",
      );
    }

    const rawRows = await fixture.database
      .select({ state: deletionRequests.state })
      .from(deletionRequests)
      .where(eq(deletionRequests.workspaceId, owner.workspaceId));
    expect(rawRows.map((row) => row.state).sort()).toEqual([
      "requested",
      "requested",
      "requested",
    ]);
    expect(
      await fixture.database
        .select()
        .from(privacyRequests)
        .where(eq(privacyRequests.workspaceId, owner.workspaceId)),
    ).toHaveLength(0);
    expect(
      await fixture.database
        .select()
        .from(privacyProcessorPropagations)
        .where(eq(privacyProcessorPropagations.workspaceId, owner.workspaceId)),
    ).toHaveLength(0);
  });

  it("replays every governed settings deletion step without duplicating canonical effects", async () => {
    const owner = await fixture.createActor();
    const reviewer = await fixture.createWorkspaceMember(owner, "admin");
    const otherReviewer = await fixture.createWorkspaceMember(owner, "admin");
    const foreign = await fixture.createActor();
    const subject = await fixture.execute<{
      createPerson: { person: { id: string } | null };
    }>({
      jar: owner.jar,
      operationName: "CreatePerson",
      query: CreatePersonDocument,
      variables: { input: { displayName: "Governed settings subject" } },
    });
    const subjectId = subject.body?.data?.createPerson.person?.id;
    if (!subjectId) throw new Error("Missing governed settings subject");
    const foreignSubject = await fixture.execute<{
      createPerson: { person: { id: string } | null };
    }>({
      jar: foreign.jar,
      operationName: "CreatePerson",
      query: CreatePersonDocument,
      variables: { input: { displayName: "Foreign governed subject" } },
    });
    const foreignSubjectId = foreignSubject.body?.data?.createPerson.person?.id;
    if (!foreignSubjectId) throw new Error("Missing foreign governed subject");

    const evidenceId = newId();
    await fixture.database.insert(files).values({
      id: evidenceId,
      workspaceId: owner.workspaceId,
      storageProvider: "s3",
      storageBucket: "test",
      storageKey: `privacy-verification/${evidenceId}`,
      originalName: "governed-settings-verification.txt",
      byteSize: 1,
      checksum: "a".repeat(64),
      quarantineState: "available",
      scanState: "clean",
      uploadedBy: owner.userId,
      createdBy: owner.principalId,
      updatedBy: owner.principalId,
    });

    const createInput = {
      personIds: [subjectId],
      dueAt: new Date(Date.now() + 86_400_000).toISOString(),
      idempotencyKey: "settings-governed-deletion-create-replay",
      requestType: "DELETION",
    };
    const create = () =>
      fixture.execute<{
        createPrivacyRequest: {
          auditReference: string;
          id: string;
          state: string;
          version: number;
        };
      }>({
        jar: owner.jar,
        operationName: "CreateGovernedDeletionRequestFromSettings",
        query: CreateGovernedDeletionRequestFromSettingsDocument,
        variables: { input: createInput },
      });
    const created = await create();
    expect(created.body?.errors).toBeUndefined();
    const createdRequest = created.body?.data?.createPrivacyRequest;
    expect(createdRequest).toMatchObject({ state: "requested", version: 1 });
    if (!createdRequest) throw new Error("Missing governed settings request");
    expect((await create()).body?.data?.createPrivacyRequest).toEqual(
      createdRequest,
    );

    expectGraphQLError(
      await fixture.execute({
        jar: owner.jar,
        operationName: "CreateGovernedDeletionRequestFromSettings",
        query: CreateGovernedDeletionRequestFromSettingsDocument,
        variables: {
          input: {
            ...createInput,
            idempotencyKey: "settings-governed-foreign-scope",
            personIds: [foreignSubjectId],
          },
        },
      }),
      "NOT_FOUND",
    );

    const reviewVariables = {
      expectedVersion: createdRequest.version,
      id: createdRequest.id,
      idempotencyKey: "settings-governed-deletion-review-replay",
      state: "APPROVED",
      verificationEvidenceId: evidenceId,
    };
    const review = () =>
      fixture.execute<{
        reviewPrivacyRequest: {
          auditReference: string;
          id: string;
          state: string;
          version: number;
        };
      }>({
        jar: reviewer.jar,
        operationName: "ReviewGovernedDeletionRequestFromSettings",
        query: ReviewGovernedDeletionRequestFromSettingsDocument,
        variables: reviewVariables,
      });
    const reviewed = await review();
    expect(reviewed.body?.errors).toBeUndefined();
    const reviewedRequest = reviewed.body?.data?.reviewPrivacyRequest;
    expect(reviewedRequest).toMatchObject({ state: "approved", version: 2 });
    if (!reviewedRequest) throw new Error("Missing governed settings review");
    expect((await review()).body?.data?.reviewPrivacyRequest).toEqual(
      reviewedRequest,
    );

    const fulfillVariables = {
      expectedVersion: reviewedRequest.version,
      id: reviewedRequest.id,
      idempotencyKey: "settings-governed-deletion-fulfill-replay",
    };
    const fulfill = (
      jar: Awaited<ReturnType<ResearchFixture["createActor"]>>["jar"],
    ) =>
      fixture.execute<{
        fulfillPrivacyRequest: {
          auditReference: string;
          id: string;
          state: string;
          version: number;
        };
      }>({
        jar,
        operationName: "FulfillGovernedDeletionRequestFromSettings",
        query: FulfillGovernedDeletionRequestFromSettingsDocument,
        variables: fulfillVariables,
      });
    const fulfilled = await fulfill(reviewer.jar);
    expect(fulfilled.body?.errors).toBeUndefined();
    const fulfilledRequest = fulfilled.body?.data?.fulfillPrivacyRequest;
    expect(fulfilledRequest).toMatchObject({
      state: "fulfilling",
      version: 3,
    });
    if (!fulfilledRequest)
      throw new Error("Missing governed settings fulfillment");
    expect(
      (await fulfill(reviewer.jar)).body?.data?.fulfillPrivacyRequest,
    ).toEqual(fulfilledRequest);
    expectGraphQLError(await fulfill(otherReviewer.jar), "CONFLICT");

    const canonicalRows = await fixture.database
      .select({
        id: privacyRequests.id,
        legacyDeletionRequestId: privacyRequests.legacyDeletionRequestId,
        state: privacyRequests.state,
      })
      .from(privacyRequests)
      .where(eq(privacyRequests.workspaceId, owner.workspaceId));
    expect(canonicalRows).toEqual([
      {
        id: createdRequest.id,
        legacyDeletionRequestId: expect.any(String),
        state: "fulfilling",
      },
    ]);
    const rawRows = await fixture.database
      .select({
        id: deletionRequests.id,
        state: deletionRequests.state,
      })
      .from(deletionRequests)
      .where(eq(deletionRequests.workspaceId, owner.workspaceId));
    expect(rawRows).toEqual([
      {
        id: canonicalRows[0]?.legacyDeletionRequestId,
        state: "approved",
      },
    ]);
    const processorRows = await fixture.database
      .select({
        privacyRequestId: privacyProcessorPropagations.privacyRequestId,
        processor: privacyProcessorPropagations.processor,
      })
      .from(privacyProcessorPropagations)
      .where(eq(privacyProcessorPropagations.workspaceId, owner.workspaceId));
    expect(
      processorRows.map((row) => ({
        privacyRequestId: row.privacyRequestId,
        processor: row.processor,
      })),
    ).toEqual(
      expect.arrayContaining(
        ["ai_provider", "cache", "email", "files", "search"].map(
          (processor) => ({
            privacyRequestId: createdRequest.id,
            processor,
          }),
        ),
      ),
    );
    expect(processorRows).toHaveLength(5);
    const requestAudits = await fixture.database
      .select({ action: auditEvents.action })
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.workspaceId, owner.workspaceId),
          eq(auditEvents.resourceId, createdRequest.id),
        ),
      );
    expect(requestAudits.map((row) => row.action).sort()).toEqual([
      "privacy.request.created",
      "privacy.request.fulfillment_started",
      "privacy.request.reviewed",
    ]);
  });

  it("delegates legal holds to canonical visibility, audit, replay, and independent release", async () => {
    const owner = await fixture.createActor();
    const reviewer = await fixture.createWorkspaceMember(owner, "admin");
    const person = await fixture.execute<{
      createPerson: { person: { id: string } | null };
    }>({
      jar: owner.jar,
      operationName: "CreatePerson",
      query: CreatePersonDocument,
      variables: { input: { displayName: "Canonical hold subject" } },
    });
    const personId = person.body?.data?.createPerson.person?.id;
    if (!personId) throw new Error("Missing canonical hold subject");
    const input = {
      authority: "privacy officer",
      idempotencyKey: "canonical-settings-hold-create",
      reason: "Preservation review",
      resourceId: personId,
      resourceKind: " PERSON ",
    };
    const created = await fixture.execute<{
      createLegalHold: {
        code: string;
        id: string | null;
        requestId: string;
        version: number | null;
      };
    }>({
      jar: owner.jar,
      operationName: "CreateLegalHold",
      query: CreateLegalHoldDocument,
      variables: { input },
    });
    expect(created.body?.errors).toBeUndefined();
    const hold = created.body?.data?.createLegalHold;
    expect(hold).toMatchObject({ code: "APPLIED", version: 1 });
    const holdId = hold?.id;
    if (!holdId) throw new Error("Missing canonical hold");
    const [storedHold] = await fixture.database
      .select({ resourceKind: legalHolds.resourceKind })
      .from(legalHolds)
      .where(eq(legalHolds.id, holdId));
    expect(storedHold?.resourceKind).toBe("person");
    const replay = await fixture.execute({
      jar: owner.jar,
      operationName: "CreateLegalHold",
      query: CreateLegalHoldDocument,
      variables: { input },
    });
    expect(replay.body?.data?.createLegalHold).toEqual(hold);

    const releaseInput = {
      expectedVersion: 1,
      id: holdId,
      idempotencyKey: "canonical-settings-hold-release",
      releaseReason: "Review complete",
    };
    expectGraphQLError(
      await fixture.execute({
        jar: owner.jar,
        operationName: "ReleaseLegalHold",
        query: ReleaseLegalHoldDocument,
        variables: { input: releaseInput },
      }),
      "PRECONDITION_FAILED",
    );
    const released = await fixture.execute({
      jar: reviewer.jar,
      operationName: "ReleaseLegalHold",
      query: ReleaseLegalHoldDocument,
      variables: { input: releaseInput },
    });
    expect(released.body?.errors).toBeUndefined();
    expect(released.body?.data?.releaseLegalHold).toMatchObject({
      code: "APPLIED",
      id: holdId,
      version: 2,
    });
    expect(
      (
        await fixture.execute({
          jar: reviewer.jar,
          operationName: "ReleaseLegalHold",
          query: ReleaseLegalHoldDocument,
          variables: { input: releaseInput },
        })
      ).body?.data?.releaseLegalHold,
    ).toEqual(released.body?.data?.releaseLegalHold);

    const audits = await fixture.database
      .select({ action: auditEvents.action })
      .from(auditEvents)
      .where(eq(auditEvents.resourceId, holdId));
    expect(audits.map((audit) => audit.action).sort()).toEqual([
      "privacy.legal_hold.approved",
      "privacy.legal_hold.released",
    ]);

    const foreign = await fixture.createActor();
    const foreignPerson = await fixture.execute<{
      createPerson: { person: { id: string } | null };
    }>({
      jar: foreign.jar,
      operationName: "CreatePerson",
      query: CreatePersonDocument,
      variables: { input: { displayName: "Foreign hold subject" } },
    });
    const foreignPersonId = foreignPerson.body?.data?.createPerson.person?.id;
    if (!foreignPersonId) throw new Error("Missing foreign hold subject");
    expectGraphQLError(
      await fixture.execute({
        jar: owner.jar,
        operationName: "CreateLegalHold",
        query: CreateLegalHoldDocument,
        variables: {
          input: {
            ...input,
            idempotencyKey: "canonical-settings-foreign-hold",
            resourceId: foreignPersonId,
          },
        },
      }),
      "NOT_FOUND",
    );
    expectGraphQLError(
      await fixture.execute({
        jar: owner.jar,
        operationName: "CreateLegalHold",
        query: CreateLegalHoldDocument,
        variables: {
          input: {
            ...input,
            idempotencyKey: "canonical-settings-invalid-hold-kind",
            resourceKind: " person! ",
          },
        },
      }),
      "VALIDATION_FAILED",
    );
  });

  it("executes approved person deletion requests once and preserves redacted worker audit", async () => {
    const owner = await fixture.createActor();
    const created = await fixture.execute<{
      createPerson: { person: { id: string } | null };
    }>({
      jar: owner.jar,
      operationName: "CreatePerson",
      query: CreatePersonDocument,
      variables: { input: { displayName: "Deletion executor subject" } },
    });
    const personId = created.body?.data?.createPerson.person?.id;
    if (!personId) throw new Error("Missing deletion executor person");
    const researchRunId = newId();
    const researchSourceId = newId();
    await fixture.database.insert(personWebResearchRuns).values({
      id: researchRunId,
      workspaceId: owner.workspaceId,
      personId,
      governancePurpose: "subject-rights test",
      provider: "COMPATIBLE",
      model: "test-model",
      queryHash: "a".repeat(64),
      sourceCount: 1,
      sources: [
        {
          title: "Public source",
          url: "https://example.com/source",
          snippet: "redacted test snippet",
        },
      ],
      suggestions: [],
      consentedAt: new Date(),
      createdBy: owner.principalId,
    });
    await fixture.database.insert(personWebResearchSources).values({
      id: researchSourceId,
      workspaceId: owner.workspaceId,
      runId: researchRunId,
      personId,
      url: "https://example.com/source",
      title: "Public source",
      snippet: "redacted test snippet",
      retrievalHash: "b".repeat(64),
      provider: "COMPATIBLE",
      model: "test-model",
      metadata: {},
    });
    const suggestionId = newId();
    await fixture.database.insert(aiReviewSuggestions).values({
      id: suggestionId,
      workspaceId: owner.workspaceId,
      personId,
      purpose: "subject-rights test",
      fieldKey: "biography",
      proposedValue: { version: 1, kind: "profile", value: "draft" },
      evidenceReferences: [
        {
          kind: "web",
          url: "https://example.com/source",
          locator: "snippet",
          quote: "redacted test snippet",
        },
      ],
      confidence: 0.5,
      uncertainty: "test uncertainty",
      provider: "COMPATIBLE",
      model: "test-model",
      promptPolicyVersion: "v1",
      webRunId: researchRunId,
      createdBy: owner.principalId,
      updatedBy: owner.principalId,
    });
    const aiThreadId = newId();
    const aiInputMessageId = newId();
    const aiAssistantMessageId = newId();
    const aiRunId = newId();
    const aiCreatedAt = new Date();
    await fixture.database.insert(aiThreads).values({
      id: aiThreadId,
      workspaceId: owner.workspaceId,
      ownerId: owner.principalId,
      title: "Deletion AI thread",
      sharing: "private",
      createdAt: aiCreatedAt,
      createdBy: owner.principalId,
      updatedAt: aiCreatedAt,
      updatedBy: owner.principalId,
    });
    await fixture.database.insert(aiMessages).values({
      id: aiInputMessageId,
      workspaceId: owner.workspaceId,
      threadId: aiThreadId,
      role: "user",
      encryptedContent: "sealed:subject-input",
      contentHash: "sha256:subject-input",
      createdAt: aiCreatedAt,
      createdBy: owner.principalId,
      updatedAt: aiCreatedAt,
      updatedBy: owner.principalId,
    });
    await fixture.database.insert(aiRuns).values({
      id: aiRunId,
      workspaceId: owner.workspaceId,
      threadId: aiThreadId,
      reviewPersonIds: [personId],
      messageId: aiInputMessageId,
      provider: "COMPATIBLE",
      baseUrlFingerprint: "a".repeat(64),
      model: "test-model",
      capabilityProfile: { version: 1 },
      promptHash: "sha256:subject-prompt",
      configurationHash: "sha256:subject-config",
      state: "completed",
      createdAt: aiCreatedAt,
      createdBy: owner.principalId,
    });
    await fixture.database.insert(aiMessages).values({
      id: aiAssistantMessageId,
      workspaceId: owner.workspaceId,
      threadId: aiThreadId,
      aiRunId,
      role: "assistant",
      encryptedContent: "sealed:subject-response",
      contentHash: "sha256:subject-response",
      createdAt: aiCreatedAt,
      createdBy: owner.principalId,
      updatedAt: aiCreatedAt,
      updatedBy: owner.principalId,
    });
    const sharedInputMessageId = newId();
    const sharedAssistantMessageId = newId();
    const sharedRunId = newId();
    await fixture.database.insert(aiMessages).values({
      id: sharedInputMessageId,
      workspaceId: owner.workspaceId,
      threadId: aiThreadId,
      role: "user",
      encryptedContent: "sealed:shared-input",
      contentHash: "sha256:shared-input",
      createdAt: aiCreatedAt,
      createdBy: owner.principalId,
      updatedAt: aiCreatedAt,
      updatedBy: owner.principalId,
    });
    await fixture.database.insert(aiRuns).values({
      id: sharedRunId,
      workspaceId: owner.workspaceId,
      threadId: aiThreadId,
      reviewPersonIds: [],
      messageId: sharedInputMessageId,
      provider: "COMPATIBLE",
      baseUrlFingerprint: "b".repeat(64),
      model: "test-model",
      capabilityProfile: { version: 1 },
      promptHash: "sha256:shared-prompt",
      configurationHash: "sha256:shared-config",
      state: "completed",
      createdAt: aiCreatedAt,
      createdBy: owner.principalId,
    });
    await fixture.database.insert(aiMessages).values({
      id: sharedAssistantMessageId,
      workspaceId: owner.workspaceId,
      threadId: aiThreadId,
      aiRunId: sharedRunId,
      role: "assistant",
      encryptedContent: "sealed:shared-response",
      contentHash: "sha256:shared-response",
      createdAt: aiCreatedAt,
      createdBy: owner.principalId,
      updatedAt: aiCreatedAt,
      updatedBy: owner.principalId,
    });

    const requestId = await startGovernedDeletion(
      owner,
      { personIds: [personId] },
      "deletion-executor-create",
    );

    await expect(
      executeApprovedDeletionRequests({
        database: fixture.database,
        encryptionKey: "42".repeat(32),
      }),
    ).resolves.toBe(1);
    await expect(
      executeApprovedDeletionRequests({
        database: fixture.database,
        encryptionKey: "42".repeat(32),
      }),
    ).resolves.toBe(0);

    const [person] = await fixture.database
      .select({ deletedAt: people.deletedAt, status: people.status })
      .from(people)
      .where(eq(people.id, personId));
    expect(person).toMatchObject({ status: "archived" });
    expect(person?.deletedAt).toBeInstanceOf(Date);
    expect(
      await fixture.database
        .select({ id: personWebResearchRuns.id })
        .from(personWebResearchRuns)
        .where(eq(personWebResearchRuns.id, researchRunId)),
    ).toHaveLength(0);
    expect(
      await fixture.database
        .select({ id: personWebResearchSources.id })
        .from(personWebResearchSources)
        .where(eq(personWebResearchSources.id, researchSourceId)),
    ).toHaveLength(0);
    expect(
      await fixture.database
        .select({ id: aiReviewSuggestions.id })
        .from(aiReviewSuggestions)
        .where(eq(aiReviewSuggestions.id, suggestionId)),
    ).toHaveLength(0);
    expect(
      await fixture.database
        .select({ id: aiRuns.id })
        .from(aiRuns)
        .where(eq(aiRuns.id, aiRunId)),
    ).toHaveLength(0);
    expect(
      await fixture.database
        .select({
          id: aiMessages.id,
          encryptedContent: aiMessages.encryptedContent,
        })
        .from(aiMessages)
        .where(eq(aiMessages.threadId, aiThreadId)),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: sharedAssistantMessageId,
          encryptedContent: "sealed:shared-response",
        }),
        expect.objectContaining({ id: sharedInputMessageId }),
      ]),
    );
    const [completedRequest] = await fixture.database
      .select({ state: deletionRequests.state })
      .from(deletionRequests)
      .where(eq(deletionRequests.id, requestId));
    expect(completedRequest?.state).toBe("completed");
    const workerAudits = await fixture.database
      .select({
        action: auditEvents.action,
        redactedDiff: auditEvents.redactedDiff,
      })
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.workspaceId, owner.workspaceId),
          eq(auditEvents.resourceId, requestId),
        ),
      );
    expect(workerAudits.map((audit) => audit.action)).toContain(
      "deletion_request.completed",
    );
    expect(JSON.stringify(workerAudits)).not.toContain(personId);

    const heldCreated = await fixture.execute<{
      createPerson: { person: { id: string } | null };
    }>({
      jar: owner.jar,
      operationName: "CreatePerson",
      query: CreatePersonDocument,
      variables: { input: { displayName: "Held deletion subject" } },
    });
    const heldPersonId = heldCreated.body?.data?.createPerson.person?.id;
    if (!heldPersonId) throw new Error("Missing held deletion person");
    const heldRequestId = await startGovernedDeletion(
      owner,
      { personIds: [heldPersonId] },
      "deletion-executor-held-create",
    );
    await fixture.database.insert(legalHolds).values({
      id: newId(),
      workspaceId: owner.workspaceId,
      resourceId: heldPersonId,
      resourceKind: "person",
      reason: "Retention hold",
      authority: "Privacy officer",
      createdBy: owner.principalId,
      updatedBy: owner.principalId,
    });
    await expect(
      executeApprovedDeletionRequests({
        database: fixture.database,
        encryptionKey: "42".repeat(32),
      }),
    ).resolves.toBe(0);
    await expect(
      executeApprovedDeletionRequests({
        database: fixture.database,
        encryptionKey: "42".repeat(32),
      }),
    ).resolves.toBe(0);
    const [heldPerson] = await fixture.database
      .select({ deletedAt: people.deletedAt })
      .from(people)
      .where(eq(people.id, heldPersonId));
    expect(heldPerson?.deletedAt).toBeNull();
    const heldAudits = await fixture.database
      .select({ action: auditEvents.action })
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.workspaceId, owner.workspaceId),
          eq(auditEvents.resourceId, heldRequestId),
          eq(auditEvents.action, "deletion_request.blocked"),
        ),
      );
    expect(heldAudits).toHaveLength(1);
  });

  it("blocks a person deletion when a linked AI child is held without a suggestion", async () => {
    const owner = await fixture.createActor();
    const created = await fixture.execute<{
      createPerson: { person: { id: string } | null };
    }>({
      jar: owner.jar,
      operationName: "CreatePerson",
      query: CreatePersonDocument,
      variables: { input: { displayName: "Held AI run subject" } },
    });
    const personId = created.body?.data?.createPerson.person?.id;
    if (!personId) throw new Error("Missing held AI person");
    const threadId = newId();
    const messageId = newId();
    const runId = newId();
    const now = new Date();
    await fixture.database.insert(aiThreads).values({
      id: threadId,
      workspaceId: owner.workspaceId,
      ownerId: owner.principalId,
      title: "Held AI run",
      sharing: "private",
      createdAt: now,
      createdBy: owner.principalId,
      updatedAt: now,
      updatedBy: owner.principalId,
    });
    await fixture.database.insert(aiMessages).values({
      id: messageId,
      workspaceId: owner.workspaceId,
      threadId,
      role: "user",
      encryptedContent: "sealed:omitted",
      contentHash: "sha256:omitted",
      createdAt: now,
      createdBy: owner.principalId,
      updatedAt: now,
      updatedBy: owner.principalId,
    });
    await fixture.database.insert(aiRuns).values({
      id: runId,
      workspaceId: owner.workspaceId,
      threadId,
      reviewPersonIds: [personId],
      messageId,
      provider: "COMPATIBLE",
      baseUrlFingerprint: "a".repeat(64),
      model: "test-model",
      capabilityProfile: { version: 1 },
      promptHash: "sha256:prompt",
      configurationHash: "sha256:configuration",
      state: "completed",
      createdAt: now,
      createdBy: owner.principalId,
    });
    const ephemeralInputId = newId();
    await fixture.database.insert(aiEphemeralInputs).values({
      id: ephemeralInputId,
      workspaceId: owner.workspaceId,
      threadId,
      aiRunId: runId,
      encryptedContent: "sealed:ephemeral-subject-input",
      contentHash: "sha256:ephemeral-subject-input",
      createdAt: now,
      expiresAt: new Date(now.getTime() + 60_000),
    });
    await fixture.database.insert(legalHolds).values({
      id: newId(),
      workspaceId: owner.workspaceId,
      resourceId: ephemeralInputId,
      resourceKind: "ai_ephemeral_input",
      reason: "Preserve AI provenance",
      authority: "Privacy officer",
      createdBy: owner.principalId,
      updatedBy: owner.principalId,
    });
    await startGovernedDeletion(
      owner,
      { personIds: [personId] },
      "deletion-executor-held-ai-child",
    );

    await expect(
      executeApprovedDeletionRequests({
        database: fixture.database,
        encryptionKey: "42".repeat(32),
      }),
    ).resolves.toBe(0);
    const [person] = await fixture.database
      .select({ deletedAt: people.deletedAt })
      .from(people)
      .where(eq(people.id, personId));
    expect(person?.deletedAt).toBeNull();
    expect(
      await fixture.database
        .select({ id: aiRuns.id })
        .from(aiRuns)
        .where(eq(aiRuns.id, runId)),
    ).toHaveLength(1);
    expect(
      await fixture.database
        .select({ id: aiEphemeralInputs.id })
        .from(aiEphemeralInputs)
        .where(eq(aiEphemeralInputs.id, ephemeralInputId)),
    ).toHaveLength(1);
  });

  it("archives files, schedules cleanup, and removes indexed people when provided", async () => {
    const owner = await fixture.createActor();
    const person = await fixture.execute<{
      createPerson: { person: { id: string } | null };
    }>({
      jar: owner.jar,
      operationName: "CreatePerson",
      query: CreatePersonDocument,
      variables: { input: { displayName: "File deletion subject" } },
    });
    const personId = person.body?.data?.createPerson.person?.id;
    if (!personId) throw new Error("Missing file deletion person");
    const fileId = newId();
    await fixture.database.insert(files).values({
      id: fileId,
      workspaceId: owner.workspaceId,
      storageProvider: "minio",
      storageBucket: "private",
      storageKey: `uploads/${fileId}/source.txt`,
      originalName: "source.txt",
      mediaType: "text/plain",
      detectedType: "text/plain",
      byteSize: 1,
      checksum: `sha256:${"23".repeat(32)}`,
      quarantineState: "available",
      scanState: "clean",
      ocrState: "not_requested",
      extractionState: "not_requested",
      uploadedBy: owner.userId,
      createdBy: owner.userId,
      updatedBy: owner.userId,
    });
    await startGovernedDeletion(
      owner,
      { fileIds: [fileId], personIds: [personId] },
      "deletion-executor-file-create",
    );
    const apply = vi.fn(async (...args: unknown[]) => {
      void args;
    });
    await expect(
      executeApprovedDeletionRequests({
        database: fixture.database,
        encryptionKey: "42".repeat(32),
        searchIndexMaintenance: { mode: "transactional", apply },
      }),
    ).resolves.toBe(1);
    const [archived] = await fixture.database
      .select({ deletedAt: files.deletedAt })
      .from(files)
      .where(eq(files.id, fileId));
    expect(archived?.deletedAt).toBeInstanceOf(Date);
    expect(
      await fixture.database
        .select({ id: jobs.id })
        .from(jobs)
        .where(
          and(
            eq(jobs.workspaceId, owner.workspaceId),
            eq(jobs.kind, "file_cleanup"),
          ),
        ),
    ).toHaveLength(1);
    expect(apply).toHaveBeenCalledTimes(1);
    expect(apply.mock.calls[0]?.[1]).toEqual([
      expect.objectContaining({
        action: "remove",
        sourceId: personId,
        sourceKind: "person",
      }),
    ]);
  });
});
