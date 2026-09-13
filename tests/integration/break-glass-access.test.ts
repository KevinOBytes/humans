// @vitest-environment node
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";

import { newId } from "@/db/id";
import { auditEvents } from "@/db/schema/operations";
import { sessions } from "@/db/schema/auth";
import { createBreakGlassService } from "@/modules/governance/break-glass-service";
import type { ResearchServiceContext } from "@/modules/audit/service";
import { canAccessResource } from "@/modules/audit/service";
import { rolePermissionKeys } from "@/modules/auth/permissions";
import { disabledSearchIndexMaintenance } from "@/modules/search/index-maintenance";
import { ResearchFixture } from "../support/research-fixture";
import type { SessionActor } from "../support/graphql";

const liveDescribe = process.env.TEST_DATABASE_URL ? describe : describe.skip;

liveDescribe("break-glass access lifecycle", () => {
  const secret = "ab".repeat(32);
  const fixture = new ResearchFixture();

  beforeEach(async () => {
    await fixture.reset();
  });

  afterAll(async () => {
    await fixture.close();
  });

  async function context(
    actor: SessionActor,
    role: "owner" | "admin" | "analyst" = "owner",
  ): Promise<ResearchServiceContext> {
    const [session] = await fixture.database
      .select()
      .from(sessions)
      .where(eq(sessions.userId, actor.userId))
      .limit(1);
    return {
      actor: {
        type: "user",
        id: actor.userId,
        principalId: actor.principalId,
        memberId: actor.memberId,
        sessionId: session!.id,
        role,
      },
      database: fixture.database,
      idempotencyHmacKey: secret,
      permissions: rolePermissionKeys(role),
      requestId: newId(),
      searchIndexMaintenance: disabledSearchIndexMaintenance,
      workspaceId: actor.workspaceId,
    };
  }

  it("requires independent review, enumerates resources, audits use, and revokes", async () => {
    const owner = await fixture.createActor("owner");
    const requester = await fixture.createWorkspaceMember(owner, "analyst");
    const requesterContext = await context(requester, "analyst");
    const ownerContext = await context(owner, "owner");
    const person = await fixture.createPerson(owner, {
      displayName: "Protected synthetic subject",
      sensitivity: "RESTRICTED",
    });
    const resourceId = person.body?.data?.createPerson?.person?.id;
    if (!resourceId) throw new Error("Synthetic person was not created.");
    const input = {
      purpose: "incident response",
      justification:
        "A documented incident requires a time-limited review of this record.",
      expiresAt: new Date(Date.now() + 60 * 60 * 1_000).toISOString(),
      resources: [{ resourceKind: "person", resourceId: resourceId! }],
      idempotencyKey: "break-glass-request-1",
    };
    const requested =
      await createBreakGlassService(requesterContext).request(input);
    expect(requested).toMatchObject({
      state: "requested",
      requesterPrincipalId: requester.principalId,
      resources: [{ resourceKind: "person", resourceId: resourceId! }],
    });
    expect(
      (await createBreakGlassService(requesterContext).request(input)).id,
    ).toBe(requested.id);

    await expect(
      createBreakGlassService(requesterContext).review({
        id: requested.id,
        expectedVersion: requested.version,
        state: "approved",
        reason: "The requester cannot approve their own exceptional access.",
        idempotencyKey: "break-glass-self-review",
      }),
    ).rejects.toThrow("not permitted");

    const approved = await createBreakGlassService(ownerContext).review({
      id: requested.id,
      expectedVersion: requested.version,
      state: "approved",
      reason: "Independent review confirms this narrowly scoped exception.",
      idempotencyKey: "break-glass-review-1",
    });
    expect(approved).toMatchObject({ state: "approved", version: 2 });
    expect(
      await canAccessResource(requesterContext.database, requesterContext, {
        id: resourceId,
        resourceKind: "person",
        sensitivity: "restricted",
      }),
    ).toBe(true);

    const revoked = await createBreakGlassService(ownerContext).revoke({
      id: approved.id,
      expectedVersion: approved.version,
      reason: "The incident review is complete and access is no longer needed.",
      idempotencyKey: "break-glass-revoke-1",
    });
    expect(revoked).toMatchObject({ state: "revoked", version: 3 });
    expect(
      await canAccessResource(requesterContext.database, requesterContext, {
        id: resourceId,
        resourceKind: "person",
        sensitivity: "restricted",
      }),
    ).toBe(false);

    const events = await fixture.database
      .select({ action: auditEvents.action })
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.workspaceId, owner.workspaceId),
          eq(auditEvents.resourceId, requested.id),
        ),
      );
    expect(events.map((event) => event.action).sort()).toEqual([
      "governance.break_glass.request",
      "governance.break_glass.review",
      "governance.break_glass.revoke",
    ]);
  });
});
