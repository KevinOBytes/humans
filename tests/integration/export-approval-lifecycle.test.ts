// @vitest-environment node

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq, inArray, sql } from "drizzle-orm";

import { newId } from "@/db/id";
import { caseMembers } from "@/db/schema/cases";
import { exportApprovals } from "@/db/schema/export-approvals";
import { auditEvents, idempotencyKeys } from "@/db/schema/operations";
import { rolePermissionKeys } from "@/modules/auth/permissions";
import type { ResearchServiceContext } from "@/modules/audit/service";
import { createCasesService } from "@/modules/cases/service";
import { createExportApprovalService } from "@/modules/exports/approval-service";
import { caseContext } from "../support/cases";
import { expectGraphQLError } from "../support/graphql";
import { ResearchFixture } from "../support/research-fixture";

const liveDescribe = process.env.TEST_DATABASE_URL ? describe : describe.skip;
const hash = "c3".repeat(32);

const REQUEST = /* GraphQL */ `
  mutation RequestExportApproval($input: RequestExportApprovalInput!) {
    requestExportApproval(input: $input) {
      id
      workspaceId
      purpose
      caseId
      previewHash
      redactionProfile
      requestedByPrincipalId
      reviewedByPrincipalId
      state
      requestReason
      decisionReason
      expiresAt
      version
      requestAuditReference
      reviewAuditReference
    }
  }
`;

const REVIEW = /* GraphQL */ `
  mutation ReviewExportApproval($input: ReviewExportApprovalInput!) {
    reviewExportApproval(input: $input) {
      id
      state
      decisionReason
      reviewedByPrincipalId
      reviewedAt
      version
      reviewAuditReference
    }
  }
`;

const PENDING = /* GraphQL */ `
  query PendingExportApprovals($caseId: UUID, $first: Int!) {
    pendingExportApprovals(caseId: $caseId, first: $first) {
      id
      caseId
      previewHash
      purpose
      redactionProfile
      requestedByPrincipalId
      state
      requestReason
      expiresAt
      version
    }
  }
`;

liveDescribe("reviewed governed export approval lifecycle", () => {
  let fixture: ResearchFixture;

  beforeAll(() => {
    fixture = new ResearchFixture();
  });
  beforeEach(() => fixture.reset());
  afterAll(() => fixture.close());

  it("exposes replay-safe request/review mutations and exact approved bindings", async () => {
    const owner = await fixture.createActor();
    const admin = await fixture.createWorkspaceMember(owner, "admin");
    const expiresAt = new Date(Date.now() + 30 * 60_000).toISOString();
    const requestInput = {
      purpose: "research export",
      caseId: null,
      previewHash: hash,
      redactionProfile: "CONFIDENTIAL",
      requestReason: "The governed preview requires independent review.",
      expiresAt,
      idempotencyKey: "graphql-export-request",
    };

    const first = await fixture.execute<{
      requestExportApproval: { id: string; version: number; state: string };
    }>({ jar: owner.jar, query: REQUEST, variables: { input: requestInput } });
    expect(first.body?.errors).toBeUndefined();
    const requested = first.body?.data?.requestExportApproval;
    expect(requested).toMatchObject({ state: "REQUESTED", version: 1 });

    const replay = await fixture.execute<{
      requestExportApproval: { id: string; version: number; state: string };
    }>({ jar: owner.jar, query: REQUEST, variables: { input: requestInput } });
    expect(replay.body?.data?.requestExportApproval).toEqual(requested);

    const pendingBeforeReview = await fixture.execute<{
      pendingExportApprovals: Array<{ id: string; previewHash: string }>;
    }>({
      jar: admin.jar,
      query: PENDING,
      variables: { caseId: null, first: 25 },
    });
    expect(pendingBeforeReview.body?.errors).toBeUndefined();
    expect(pendingBeforeReview.body?.data?.pendingExportApprovals).toEqual([
      expect.objectContaining({ id: requested!.id, previewHash: hash }),
    ]);

    const reviewInput = {
      id: requested!.id,
      expectedVersion: 1,
      expectedPreviewHash: hash,
      decision: "APPROVED",
      reason: "Purpose, scope, provenance and redaction were reviewed.",
      idempotencyKey: "graphql-export-review",
    };
    const reviewed = await fixture.execute<{
      reviewExportApproval: { id: string; version: number; state: string };
    }>({ jar: admin.jar, query: REVIEW, variables: { input: reviewInput } });
    expect(reviewed.body?.errors).toBeUndefined();
    expect(reviewed.body?.data?.reviewExportApproval).toMatchObject({
      id: requested!.id,
      state: "APPROVED",
      version: 2,
    });
    const reviewReplay = await fixture.execute<{
      reviewExportApproval: { id: string; version: number; state: string };
    }>({ jar: admin.jar, query: REVIEW, variables: { input: reviewInput } });
    expect(reviewReplay.body?.errors).toBeUndefined();
    expect(reviewReplay.body?.data?.reviewExportApproval).toEqual(
      reviewed.body?.data?.reviewExportApproval,
    );
    const pendingAfterReview = await fixture.execute<{
      pendingExportApprovals: Array<{ id: string }>;
    }>({
      jar: admin.jar,
      query: PENDING,
      variables: { caseId: null, first: 25 },
    });
    expect(pendingAfterReview.body?.errors).toBeUndefined();
    expect(pendingAfterReview.body?.data?.pendingExportApprovals).toEqual([]);

    const ownerContext = await caseContext(fixture, owner);
    await expect(
      createExportApprovalService(ownerContext).requireApproved({
        workspaceId: owner.workspaceId,
        actorPrincipalId: owner.principalId,
        purpose: requestInput.purpose,
        caseId: null,
        previewHash: hash,
        redactionProfile: "CONFIDENTIAL",
        now: new Date(),
      }),
    ).resolves.toMatchObject({ id: requested!.id, state: "approved" });

    const rows = await fixture.database
      .select()
      .from(exportApprovals)
      .where(eq(exportApprovals.id, requested!.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      state: "approved",
      version: 2,
      previewHash: hash,
    });
    const events = await fixture.database
      .select()
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.workspaceId, owner.workspaceId),
          inArray(auditEvents.action, [
            "export.approval.requested",
            "export.approval.reviewed",
          ]),
        ),
      );
    expect(events).toHaveLength(2);
    expect(
      events.filter((event) => event.action === "export.approval.reviewed"),
    ).toHaveLength(1);
    expect(JSON.stringify(events)).not.toContain(requestInput.requestReason);
  });

  it("rejects self-review, stale versions, changed bindings and expiry", async () => {
    const owner = await fixture.createActor();
    const admin = await fixture.createWorkspaceMember(owner, "admin");
    const ownerContext = await caseContext(fixture, owner);
    const approval = await createExportApprovalService(ownerContext).request({
      purpose: "research export",
      caseId: null,
      previewHash: hash,
      redactionProfile: "RESTRICTED",
      requestReason: "Restricted export requires review.",
      expiresAt: new Date(Date.now() + 30 * 60_000),
      idempotencyKey: newId(),
    });

    expectGraphQLError(
      await fixture.execute({
        jar: owner.jar,
        query: REVIEW,
        variables: {
          input: {
            id: approval.id,
            expectedVersion: 1,
            expectedPreviewHash: hash,
            decision: "APPROVED",
            reason: "Self approval must fail.",
            idempotencyKey: newId(),
          },
        },
      }),
      "FORBIDDEN",
    );
    expectGraphQLError(
      await fixture.execute({
        jar: admin.jar,
        query: REVIEW,
        variables: {
          input: {
            id: approval.id,
            expectedVersion: 2,
            expectedPreviewHash: hash,
            decision: "APPROVED",
            reason: "Stale review must fail.",
            idempotencyKey: newId(),
          },
        },
      }),
      "CONFLICT",
    );

    const adminContextBase = await caseContext(fixture, admin);
    const adminContext: ResearchServiceContext = {
      ...adminContextBase,
      actor: {
        ...adminContextBase.actor,
        role: "admin",
      } as typeof adminContextBase.actor,
      permissions: new Set(rolePermissionKeys("admin")),
    };
    await createExportApprovalService(adminContext).review({
      id: approval.id,
      expectedVersion: 1,
      expectedPreviewHash: hash,
      decision: "approved",
      reason: "Approved after independent review.",
      idempotencyKey: newId(),
    });
    await expect(
      createExportApprovalService(ownerContext).requireApproved({
        workspaceId: owner.workspaceId,
        actorPrincipalId: owner.principalId,
        purpose: "changed purpose",
        caseId: null,
        previewHash: hash,
        redactionProfile: "RESTRICTED",
        now: new Date(),
      }),
    ).rejects.toMatchObject({ extensions: { code: "PRECONDITION_FAILED" } });

    await expect(
      createExportApprovalService(ownerContext).requireApproved({
        workspaceId: owner.workspaceId,
        actorPrincipalId: owner.principalId,
        purpose: "research export",
        caseId: null,
        previewHash: hash,
        redactionProfile: "RESTRICTED",
        now: new Date(approval.expiresAt.getTime() + 1),
      }),
    ).rejects.toMatchObject({ extensions: { code: "PRECONDITION_FAILED" } });
  });

  it("permits only an assigned owner/reviewer inside a case scope", async () => {
    const owner = await fixture.createActor();
    const analyst = await fixture.createWorkspaceMember(owner, "analyst");
    const ordinary = await fixture.createWorkspaceMember(owner, "analyst");
    const ownerContext = await caseContext(fixture, owner);
    const cases = createCasesService(ownerContext);
    const researchCase = await cases.createCase({
      title: "Synthetic export review",
      purpose: "research export",
    });
    await cases.addMember({
      caseId: researchCase.id,
      principalId: analyst.principalId,
      role: "reviewer",
    });
    await cases.addMember({
      caseId: researchCase.id,
      principalId: ordinary.principalId,
      role: "member",
    });
    const approval = await createExportApprovalService(ownerContext).request({
      purpose: "research export",
      caseId: researchCase.id,
      previewHash: hash,
      redactionProfile: "CONFIDENTIAL",
      requestReason: "Case export requires assigned review.",
      expiresAt: new Date(Date.now() + 30 * 60_000),
      idempotencyKey: newId(),
    });
    const variables = {
      input: {
        id: approval.id,
        expectedVersion: 1,
        expectedPreviewHash: hash,
        decision: "APPROVED",
        reason: "Case scope was independently reviewed.",
        idempotencyKey: newId(),
      },
    };

    const ordinaryQueue = await fixture.execute<{
      pendingExportApprovals: Array<{ id: string }>;
    }>({
      jar: ordinary.jar,
      query: PENDING,
      variables: { caseId: researchCase.id, first: 25 },
    });
    expect(ordinaryQueue.body?.errors).toBeUndefined();
    expect(ordinaryQueue.body?.data?.pendingExportApprovals).toEqual([]);
    const reviewerQueue = await fixture.execute<{
      pendingExportApprovals: Array<{ id: string; previewHash: string }>;
    }>({
      jar: analyst.jar,
      query: PENDING,
      variables: { caseId: researchCase.id, first: 25 },
    });
    expect(reviewerQueue.body?.errors).toBeUndefined();
    expect(reviewerQueue.body?.data?.pendingExportApprovals).toEqual([
      expect.objectContaining({ id: approval.id, previewHash: hash }),
    ]);

    expectGraphQLError(
      await fixture.execute({ jar: ordinary.jar, query: REVIEW, variables }),
      "FORBIDDEN",
    );
    const reviewed = await fixture.execute<{
      reviewExportApproval: { state: string; version: number };
    }>({ jar: analyst.jar, query: REVIEW, variables });
    expect(reviewed.body?.errors).toBeUndefined();
    expect(reviewed.body?.data?.reviewExportApproval).toMatchObject({
      state: "APPROVED",
      version: 2,
    });
    await fixture.database
      .update(caseMembers)
      .set({ deletedAt: new Date(), deletedBy: owner.principalId })
      .where(
        and(
          eq(caseMembers.workspaceId, owner.workspaceId),
          eq(caseMembers.caseId, researchCase.id),
          eq(caseMembers.principalId, analyst.principalId),
        ),
      );
    expectGraphQLError(
      await fixture.execute({ jar: analyst.jar, query: REVIEW, variables }),
      "FORBIDDEN",
    );
  });

  it("rolls back the approval row, request audit, and idempotency claim on injected insert failure", async () => {
    const owner = await fixture.createActor();
    const failureHash = "d4".repeat(32);
    await fixture.database.execute(
      sql.raw(
        "DROP TRIGGER IF EXISTS test_fail_export_approval_insert ON export_approvals",
      ),
    );
    await fixture.database.execute(
      sql.raw("DROP FUNCTION IF EXISTS test_fail_export_approval_insert()"),
    );
    await fixture.database.execute(
      sql.raw(`
      CREATE FUNCTION test_fail_export_approval_insert() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'injected export approval insert failure';
      END;
      $$
    `),
    );
    await fixture.database.execute(
      sql.raw(`
      CREATE TRIGGER test_fail_export_approval_insert
      BEFORE INSERT ON export_approvals
      FOR EACH ROW EXECUTE FUNCTION test_fail_export_approval_insert()
    `),
    );
    try {
      const failed = await fixture.execute({
        jar: owner.jar,
        query: REQUEST,
        variables: {
          input: {
            purpose: "rollback export",
            caseId: null,
            previewHash: failureHash,
            redactionProfile: "CONFIDENTIAL",
            requestReason: "This transaction is expected to roll back.",
            expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
            idempotencyKey: "graphql-export-request-rollback",
          },
        },
      });
      expect(failed.body?.errors).toBeDefined();
    } finally {
      await fixture.database.execute(
        sql.raw(
          "DROP TRIGGER IF EXISTS test_fail_export_approval_insert ON export_approvals",
        ),
      );
      await fixture.database.execute(
        sql.raw("DROP FUNCTION IF EXISTS test_fail_export_approval_insert()"),
      );
    }

    await expect(
      fixture.database
        .select()
        .from(exportApprovals)
        .where(eq(exportApprovals.previewHash, failureHash)),
    ).resolves.toHaveLength(0);
    await expect(
      fixture.database
        .select()
        .from(auditEvents)
        .where(
          and(
            eq(auditEvents.workspaceId, owner.workspaceId),
            eq(auditEvents.action, "export.approval.requested"),
          ),
        ),
    ).resolves.toHaveLength(0);
    await expect(
      fixture.database
        .select()
        .from(idempotencyKeys)
        .where(
          and(
            eq(idempotencyKeys.workspaceId, owner.workspaceId),
            eq(idempotencyKeys.operation, "export.approval.request"),
          ),
        ),
    ).resolves.toHaveLength(0);
  });
});
