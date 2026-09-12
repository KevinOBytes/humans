// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import { researchAssignmentEvents } from "@/db/schema/research-assignments";
import { auditEvents } from "@/db/schema/operations";
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
