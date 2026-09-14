// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, count, eq } from "drizzle-orm";

import { caseMembers, caseResourceLinks, cases } from "@/db/schema/cases";
import { workspacePrincipals } from "@/db/schema/principals";
import { createInvestigationsService } from "@/modules/investigations/service";
import type { ResearchServiceContext } from "@/modules/audit/service";
import { createTeamsService } from "@/modules/teams/service";
import { teamMembers, teams as teamsTable } from "@/db/schema/teams";
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
      description: "Compare the source against the retained record.",
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
        expectedVersion: 1,
        status: "completed",
        reason: "Skip required review",
        idempotencyKey: "transition-invalid",
      }),
    ).rejects.toMatchObject({
      extensions: { code: "PRECONDITION_FAILED" },
    });
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
    const completed = await service.transition({
      id: escalated.id,
      expectedVersion: 3,
      status: "completed",
      reason: "Verification complete",
      idempotencyKey: "transition-complete",
    });
    expect(completed.status).toBe("completed");
    await expect(
      service.assign({
        id: completed.id,
        expectedVersion: 4,
        assigneePrincipalId: null,
        reason: "Closed items cannot be reassigned",
        idempotencyKey: "assign-closed",
      }),
    ).rejects.toMatchObject({
      extensions: { code: "PRECONDITION_FAILED" },
    });
    await expect(
      service.escalate({
        id: completed.id,
        expectedVersion: 4,
        reason: "Closed items cannot be escalated",
        idempotencyKey: "escalate-closed",
      }),
    ).rejects.toMatchObject({
      extensions: { code: "PRECONDITION_FAILED" },
    });
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
    await expect(
      service.assign({
        id: created.id,
        expectedVersion: 1,
        assigneePrincipalId: null,
        reason: "Closed case cannot be assigned",
        idempotencyKey: "closed-case-assign",
      }),
    ).rejects.toMatchObject({ extensions: { code: "FORBIDDEN" } });
    await expect(
      service.escalate({
        id: created.id,
        expectedVersion: 1,
        reason: "Closed case cannot escalate",
        idempotencyKey: "closed-case-escalate",
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
    await createCasesService(context).addMember({
      caseId,
      principalId: principal.principalId,
      role: "reviewer",
    });
    const principalContext = await caseContext(fixture, principal);
    principalContext.actor.role = "analyst";
    principalContext.permissions = new Set(rolePermissionKeys("analyst"));
    const principalService = createResearchAssignmentsService(principalContext);
    const other = await principalService.create({
      caseId,
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

  it("limits investigation reads to managers and explicitly shared principals", async () => {
    const investigations = createInvestigationsService(context);
    const teams = createTeamsService(context);
    const casesService = createCasesService(context);
    const lead = await fixture.createWorkspaceMember(owner, "analyst");
    const caseMember = await fixture.createWorkspaceMember(owner, "analyst");
    const teamMember = await fixture.createWorkspaceMember(owner, "analyst");
    const admin = await fixture.createWorkspaceMember(owner, "admin");
    const archivedTeamMember = await fixture.createWorkspaceMember(
      owner,
      "analyst",
    );
    const unrelated = await fixture.createWorkspaceMember(owner, "analyst");
    const apiKey = await fixture.provisionKey(owner, {
      investigation: ["read"],
    });
    const [apiKeyPrincipal] = await fixture.database
      .select({ id: workspacePrincipals.id })
      .from(workspacePrincipals)
      .where(eq(workspacePrincipals.apiKeyId, apiKey.id));
    if (!apiKeyPrincipal) throw new Error("API-key principal is missing.");

    const visible = await investigations.createInvestigation({
      title: "Explicitly shared investigation",
      objective: "Prove the investigation reader boundary.",
      purpose: "research",
      leadPrincipalId: lead.principalId,
    });
    const linkedCase = await casesService.createCase({
      title: "Second investigation case",
      purpose: "research",
    });
    const unrelatedInvestigation = await investigations.createInvestigation({
      title: "Unshared investigation",
      objective: "Ensure list results remain relationship-scoped.",
      purpose: "research",
    });
    await investigations.linkCase({ investigationId: visible.id, caseId });
    await investigations.linkCase({
      investigationId: visible.id,
      caseId: linkedCase.id,
    });
    await casesService.addMember({
      caseId: linkedCase.id,
      principalId: caseMember.principalId,
      role: "reviewer",
    });

    const activeTeam = await teams.createTeam({
      name: "Active investigation team",
    });
    await teams.linkCase({ caseId, teamId: activeTeam.id });
    await teams.addMember({
      teamId: activeTeam.id,
      principalId: teamMember.principalId,
      role: "member",
    });
    await teams.addMember({
      teamId: activeTeam.id,
      principalId: apiKeyPrincipal.id,
      role: "member",
    });

    const archivedTeam = await teams.createTeam({
      name: "Archived investigation team",
    });
    await teams.linkCase({ caseId, teamId: archivedTeam.id });
    await teams.addMember({
      teamId: archivedTeam.id,
      principalId: archivedTeamMember.principalId,
      role: "member",
    });
    await fixture.database
      .update(teamsTable)
      .set({ state: "archived" })
      .where(eq(teamsTable.id, archivedTeam.id));

    const readerContext = async (actor: typeof lead) => {
      const reader = await caseContext(fixture, actor);
      reader.actor.role = "analyst";
      reader.permissions = new Set(rolePermissionKeys("analyst"));
      return reader;
    };
    const adminContext = await caseContext(fixture, admin);
    adminContext.actor.role = "admin";
    adminContext.permissions = new Set(rolePermissionKeys("admin"));
    const apiKeyContext: ResearchServiceContext = {
      ...context,
      actor: {
        type: "apiKey",
        id: apiKey.id,
        principalId: apiKeyPrincipal.id,
        role: null,
      },
      permissions: new Set(["investigation:read"]),
    };
    const assertVisible = async (reader: ResearchServiceContext) => {
      const service = createInvestigationsService(reader);
      expect((await service.getInvestigation(visible.id)).id).toBe(visible.id);
      expect(
        (await service.listInvestigations({ first: 1 })).nodes.map(
          (row) => row.id,
        ),
      ).toEqual([visible.id]);
    };
    const assertHidden = async (reader: ResearchServiceContext) => {
      const service = createInvestigationsService(reader);
      await expect(service.getInvestigation(visible.id)).rejects.toMatchObject({
        extensions: { code: "NOT_FOUND" },
      });
      expect((await service.listInvestigations({ first: 1 })).nodes).toEqual(
        [],
      );
    };

    const assertManagerVisible = async (reader: ResearchServiceContext) => {
      const service = createInvestigationsService(reader);
      expect((await service.getInvestigation(visible.id)).id).toBe(visible.id);
      expect(
        (await service.getInvestigation(unrelatedInvestigation.id)).id,
      ).toBe(unrelatedInvestigation.id);
      expect(
        (await service.listInvestigations({ first: 10 })).nodes.map(
          (row) => row.id,
        ),
      ).toEqual(
        expect.arrayContaining([visible.id, unrelatedInvestigation.id]),
      );
    };
    await assertManagerVisible(context);
    await assertManagerVisible(adminContext);
    await assertVisible(await readerContext(lead));
    await assertVisible(await readerContext(caseMember));
    await assertVisible(await readerContext(teamMember));
    await assertVisible(apiKeyContext);
    await assertHidden(await readerContext(unrelated));
    await assertHidden(await readerContext(archivedTeamMember));

    const foreignOwner = await fixture.createActor();
    const foreignContext = await caseContext(fixture, foreignOwner);
    await assertHidden(foreignContext);
  });

  it("binds assignments to investigation and team scopes and enforces membership", async () => {
    const team = await createTeamsService(context).createTeam({
      name: "Verification team",
    });
    const investigation = await createInvestigationsService(
      context,
    ).createInvestigation({
      title: "Scoped investigation",
      objective: "Validate scoped work",
      purpose: "research",
    });
    await createTeamsService(context).linkCase({
      caseId,
      teamId: team.id,
    });
    await createInvestigationsService(context).linkCase({
      investigationId: investigation.id,
      caseId,
    });
    const analyst = await fixture.createWorkspaceMember(owner, "analyst");
    await createTeamsService(context).addMember({
      teamId: team.id,
      principalId: analyst.principalId,
      role: "reviewer",
    });
    const assignment = await createResearchAssignmentsService(context).create({
      caseId,
      investigationId: investigation.id,
      teamId: team.id,
      queueKind: "verification",
      title: "Verify scoped source",
      assigneePrincipalId: analyst.principalId,
      idempotencyKey: "scoped-assignment-create",
    });
    expect(assignment).toMatchObject({
      caseId,
      investigationId: investigation.id,
      teamId: team.id,
      assigneePrincipalId: analyst.principalId,
    });

    const analystContext = await caseContext(fixture, analyst);
    analystContext.actor.role = "analyst";
    analystContext.permissions = new Set(rolePermissionKeys("analyst"));
    const analystService = createResearchAssignmentsService(analystContext);
    expect(
      (await analystService.list({ teamId: team.id })).nodes.map(
        (row) => row.id,
      ),
    ).toEqual([assignment.id]);
    expect((await analystService.get(assignment.id)).id).toBe(assignment.id);

    await createTeamsService(context).removeMember({
      teamId: team.id,
      memberId: (
        await fixture.database
          .select({ id: teamMembers.id })
          .from(teamMembers)
          .where(
            and(
              eq(teamMembers.teamId, team.id),
              eq(teamMembers.principalId, analyst.principalId),
            ),
          )
      )[0]!.id,
    });
    await expect(analystService.get(assignment.id)).rejects.toMatchObject({
      extensions: { code: "NOT_FOUND" },
    });
  });
});
