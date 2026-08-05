// @vitest-environment node

import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  CreateAccessPolicyDocument,
  SettingsPolicyPostureDocument,
  UpdateAccessPolicyDocument,
  UpdateWorkspaceDefaultsDocument,
} from "@/graphql/generated/graphql";
import { auditEvents } from "@/db/schema/operations";

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
});
