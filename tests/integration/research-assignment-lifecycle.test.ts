// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { count, eq } from "drizzle-orm";

import { caseMembers, caseResourceLinks, cases } from "@/db/schema/cases";
import {
  researchAssignmentEvents,
  researchAssignmentItems,
} from "@/db/schema/research-assignments";
import { auditEvents } from "@/db/schema/operations";
import { rolePermissionKeys } from "@/modules/auth/permissions";
import { createCasesService } from "@/modules/cases/service";
import { createResearchAssignmentsService } from "@/modules/research-assignments/service";
import { ResearchFixture } from "../support/research-fixture";
import { caseContext } from "../support/cases";

const liveDescribe = process.env.TEST_DATABASE_URL ? describe : describe.skip;

liveDescribe("research assignment queue lifecycle", () => {
  let fixture: ResearchFixture;
  let context: Awaited<ReturnType<typeof caseContext>>;
  let caseId: string;
  let owner: Awaited<ReturnType<ResearchFixture["createActor"]>>;

  beforeAll(() => {
    fixture = new ResearchFixture();
  });
  beforeEach(async () => {
    await fixture.reset();
    owner = await fixture.createActor();
    context = await caseContext(fixture, owner);
    const researchCase = await createCasesService(context).createCase({
      title: "Queue lifecycle",
      purpose: "research",
    });
    caseId = researchCase.id;
  });
  afterAll(async () => fixture.close());

  it("isolates case queues, fences versions, records immutable events, and replays idempotently", async () => {
    const service = createResearchAssignmentsService(context);
    const created = await service.create({
      caseId,
      queueKind: "verification",
      title: "Verify source",
      description: "Compare the source against the retained record.",
      priority: 10,
      idempotencyKey: "create-queue-item",
    });
    const replay = await service.create({
      caseId,
      queueKind: "verification",
      title: "Verify source",
      priority: 10,
      idempotencyKey: "create-queue-item",
    });
    expect(replay.id).toBe(created.id);
    expect(replay.description).toBe(
      "Compare the source against the retained record.",
    );
    expect((await service.list({ caseId })).nodes).toHaveLength(1);
    await expect(
      service.transition({
        id: created.id,
        expectedVersion: 99,
        status: "in_progress",
        reason: "Start verification",
        idempotencyKey: "transition-stale",
      }),
    ).rejects.toMatchObject({ extensions: { code: "CONFLICT" } });
    const transitioned = await service.transition({
      id: created.id,
      expectedVersion: 1,
      status: "in_progress",
      reason: "Start verification",
      idempotencyKey: "transition-ok",
    });
    const escalated = await service.escalate({
      id: transitioned.id,
      expectedVersion: 2,
      reason: "Due soon",
      idempotencyKey: "escalate-ok",
    });
    expect(escalated.escalationCount).toBe(1);
    await expect(
      fixture.database
        .update(researchAssignmentEvents)
        .set({ reason: "tampered" })
        .where(eq(researchAssignmentEvents.assignmentId, created.id)),
    ).rejects.toThrow();
    await expect(
      fixture.database
        .delete(researchAssignmentEvents)
        .where(eq(researchAssignmentEvents.assignmentId, created.id)),
    ).rejects.toThrow();
    const audit = await fixture.database
      .select({ action: auditEvents.action, diff: auditEvents.redactedDiff })
      .from(auditEvents)
      .where(eq(auditEvents.resourceId, created.id));
    expect(audit.map((row) => row.action)).toEqual(
      expect.arrayContaining([
        "research_assignment.create",
        "research_assignment.status",
        "research_assignment.escalate",
      ]),
    );
    expect(JSON.stringify(audit)).not.toContain("Verify source");
    expect(JSON.stringify(audit)).not.toContain("Compare the source");
  });

  it("supports bounded event pagination and strict event cursors", async () => {
    const service = createResearchAssignmentsService(context);
    const created = await service.create({
      caseId,
      queueKind: "review",
      title: "Review event history",
      idempotencyKey: "events-create",
    });
    const transitioned = await service.transition({
      id: created.id,
      expectedVersion: 1,
      status: "in_progress",
      reason: "Begin review",
      idempotencyKey: "events-transition",
    });
    await service.escalate({
      id: transitioned.id,
      expectedVersion: 2,
      reason: "Needs a second reviewer",
      idempotencyKey: "events-escalate",
    });
    const first = await service.events({
      assignmentId: created.id,
      first: 2,
    });
    expect(first.nodes).toHaveLength(2);
    expect(first.pageInfo.hasNextPage).toBe(true);
    const second = await service.events({
      assignmentId: created.id,
      first: 2,
      after: first.pageInfo.endCursor,
    });
    expect(second.nodes).toHaveLength(1);
    expect(second.pageInfo.hasNextPage).toBe(false);
    expect(second.nodes.at(-1)?.fromEscalationCount).toBe(0);
    expect(second.nodes.at(-1)?.toEscalationCount).toBe(1);
    await expect(
      service.events({ assignmentId: created.id, after: "not-a-cursor" }),
    ).rejects.toMatchObject({ extensions: { code: "VALIDATION_FAILED" } });
  });

  it("requires case authority and case membership for assignees without granting resources", async () => {
    const service = createResearchAssignmentsService(context);
    const [beforeLinks] = await fixture.database
      .select({ total: count() })
      .from(caseResourceLinks)
      .where(eq(caseResourceLinks.caseId, caseId));
    const created = await service.create({
      caseId,
      queueKind: "verification",
      title: "Assign a reviewer",
      idempotencyKey: "assignment-authority-create",
    });
    const analyst = await fixture.createWorkspaceMember(owner, "analyst");
    await expect(
      service.assign({
        id: created.id,
        expectedVersion: 1,
        assigneePrincipalId: analyst.principalId,
        reason: "Assign outside the case",
        idempotencyKey: "assignment-foreign-assignee",
      }),
    ).rejects.toMatchObject({ extensions: { code: "FORBIDDEN" } });
    await createCasesService(context).addMember({
      caseId,
      principalId: analyst.principalId,
      role: "reviewer",
    });
    const assigned = await service.assign({
      id: created.id,
      expectedVersion: 1,
      assigneePrincipalId: analyst.principalId,
      reason: "Assign to the case reviewer",
      idempotencyKey: "assignment-valid-assignee",
    });
    expect(assigned.assigneePrincipalId).toBe(analyst.principalId);
    const [afterLinks] = await fixture.database
      .select({ total: count() })
      .from(caseResourceLinks)
      .where(eq(caseResourceLinks.caseId, caseId));
    expect(afterLinks?.total).toBe(beforeLinks?.total);

    const reviewerContext = await caseContext(fixture, analyst);
    reviewerContext.actor.role = "analyst";
    reviewerContext.permissions = new Set(rolePermissionKeys("analyst"));
    const reviewerService = createResearchAssignmentsService(reviewerContext);
    const reviewed = await reviewerService.transition({
      id: assigned.id,
      expectedVersion: 2,
      status: "in_progress",
      reason: "Reviewer starts the work",
      idempotencyKey: "reviewer-transition",
    });
    expect(reviewed.status).toBe("in_progress");
  });

  it("rejects deleted assignees and closed-case mutation authority", async () => {
    const service = createResearchAssignmentsService(context);
    const analyst = await fixture.createWorkspaceMember(owner, "analyst");
    await createCasesService(context).addMember({
      caseId,
      principalId: analyst.principalId,
      role: "reviewer",
    });
    const created = await service.create({
      caseId,
      queueKind: "review",
      title: "Deleted assignee check",
      idempotencyKey: "deleted-assignee-create",
    });
    await fixture.database
      .update(caseMembers)
      .set({ deletedAt: new Date(), deletedBy: owner.principalId })
      .where(eq(caseMembers.principalId, analyst.principalId));
    await expect(
      service.assign({
        id: created.id,
        expectedVersion: 1,
        assigneePrincipalId: analyst.principalId,
        reason: "Do not assign to deleted member",
        idempotencyKey: "deleted-assignee-assign",
      }),
    ).rejects.toMatchObject({ extensions: { code: "FORBIDDEN" } });
    await fixture.database
      .update(caseMembers)
      .set({ deletedAt: null, deletedBy: null })
      .where(eq(caseMembers.principalId, analyst.principalId));
    await fixture.database
      .update(cases)
      .set({ state: "closed" })
      .where(eq(cases.id, caseId));
    await expect(
      service.transition({
        id: created.id,
        expectedVersion: 1,
        status: "in_progress",
        reason: "Closed case cannot mutate",
        idempotencyKey: "closed-case-transition",
      }),
    ).rejects.toMatchObject({ extensions: { code: "FORBIDDEN" } });
  });

  it("fences idempotency material, principal, and concurrent creates", async () => {
    const service = createResearchAssignmentsService(context);
    const created = await service.create({
      queueKind: "review",
      title: "Idempotency material",
      idempotencyKey: "idempotency-material",
    });
    await expect(
      service.create({
        queueKind: "review",
        title: "Changed material",
        idempotencyKey: "idempotency-material",
      }),
    ).rejects.toMatchObject({ extensions: { code: "CONFLICT" } });
    const concurrent = await Promise.all([
      service.create({
        queueKind: "verification",
        title: "Concurrent queue item",
        idempotencyKey: "idempotency-concurrent",
      }),
      service.create({
        queueKind: "verification",
        title: "Concurrent queue item",
        idempotencyKey: "idempotency-concurrent",
      }),
    ]);
    expect(concurrent[0].id).toBe(concurrent[1].id);
    const principal = await fixture.createWorkspaceMember(owner, "analyst");
    const principalContext = await caseContext(fixture, principal);
    const principalService = createResearchAssignmentsService(principalContext);
    const other = await principalService.create({
      queueKind: "review",
      title: "Same raw key, different principal",
      idempotencyKey: "idempotency-principal",
    });
    const ownerOther = await service.create({
      queueKind: "review",
      title: "Same raw key, different principal",
      idempotencyKey: "idempotency-principal",
    });
    expect(ownerOther.id).not.toBe(other.id);
    expect(created.id).not.toBe(concurrent[0].id);
  });

  it("fences foreign workspaces and hides soft-deleted queue rows while retaining events", async () => {
    const service = createResearchAssignmentsService(context);
    const otherOwner = await fixture.createActor();
    const otherContext = await caseContext(fixture, otherOwner);
    const foreign = await createResearchAssignmentsService(otherContext).create(
      {
        queueKind: "review",
        title: "Foreign workspace",
        idempotencyKey: "foreign-create",
      },
    );
    await expect(service.get(foreign.id)).rejects.toMatchObject({
      extensions: { code: "NOT_FOUND" },
    });
    const local = await service.create({
      queueKind: "review",
      title: "Soft delete queue row",
      idempotencyKey: "soft-delete-create",
    });
    await fixture.database
      .update(researchAssignmentItems)
      .set({ deletedAt: new Date(), deletedBy: owner.principalId })
      .where(eq(researchAssignmentItems.id, local.id));
    await expect(service.get(local.id)).rejects.toMatchObject({
      extensions: { code: "NOT_FOUND" },
    });
    const [eventCount] = await fixture.database
      .select({ total: count() })
      .from(researchAssignmentEvents)
      .where(eq(researchAssignmentEvents.assignmentId, local.id));
    expect(eventCount?.total).toBe(1);
    await expect(
      service.events({ assignmentId: local.id }),
    ).rejects.toMatchObject({ extensions: { code: "NOT_FOUND" } });
  });

  it("does not expose a case queue without case membership", async () => {
    const service = createResearchAssignmentsService(context);
    const item = await service.create({
      caseId,
      queueKind: "review",
      title: "Restricted queue item",
      idempotencyKey: "case-item",
    });
    const other = await fixture.createWorkspaceMember(owner, "analyst");
    const otherContext = await caseContext(fixture, other);
    await expect(
      createResearchAssignmentsService(otherContext).get(item.id),
    ).rejects.toMatchObject({
      extensions: { code: "NOT_FOUND" },
    });
  });
});
