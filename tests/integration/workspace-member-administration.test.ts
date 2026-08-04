// @vitest-environment node

import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { authEmailOutbox } from "@/db/schema/auth-email-outbox";
import { invitations, members, sessions } from "@/db/schema/auth";
import { auditEvents } from "@/db/schema/operations";
import {
  enqueueAuthEmail,
  runAuthEmailOutboxOnce,
} from "@/modules/auth/email-outbox";
import { createWorkspaceMemberAdministration } from "@/modules/settings/workspace-members";
import { newId } from "@/db/id";
import { testAdminEnv } from "../support/auth";
import { expectGraphQLError } from "../support/graphql";
import { ResearchFixture } from "../support/research-fixture";

const liveDescribe = process.env.TEST_DATABASE_URL ? describe : describe.skip;

const ISSUE = /* GraphQL */ `
  mutation Issue($input: IssueWorkspaceInvitationInput!) {
    issueWorkspaceInvitation(input: $input) {
      actionId
      code
      requestId
    }
  }
`;
const DIRECTORY = /* GraphQL */ `
  query Directory {
    settingsWorkspaceDirectory {
      actorRole
      invitations {
        actionId
        email
        role
        status
      }
      members {
        nodes {
          actionId
          email
          role
          isSelf
        }
        total
      }
    }
  }
`;
const UPDATE = /* GraphQL */ `
  mutation Update($input: UpdateWorkspaceMemberRoleInput!) {
    updateWorkspaceMemberRole(input: $input) {
      actionId
      code
      requestId
    }
  }
`;
const REMOVE = /* GraphQL */ `
  mutation Remove($input: WorkspaceInvitationActionInput!) {
    removeWorkspaceMember(input: $input) {
      actionId
      code
      requestId
    }
  }
`;
const CANCEL = /* GraphQL */ `
  mutation Cancel($input: WorkspaceInvitationActionInput!) {
    cancelWorkspaceInvitation(input: $input) {
      actionId
      code
      requestId
    }
  }
`;

liveDescribe("workspace member administration transactions", () => {
  let fixture: ResearchFixture;
  let fixtureInitialized = false;
  beforeAll(() => {
    fixture = new ResearchFixture();
    fixtureInitialized = true;
  });
  beforeEach(async () => fixture.reset());
  afterAll(async () => {
    if (fixtureInitialized) {
      await fixture.close();
    }
  });

  it("serializes concurrent normalized invitations and queues one encrypted intent", async () => {
    const owner = await fixture.createActor();
    const email = "  New.Member@Example.Test ";
    const [left, right] = await Promise.all([
      fixture.execute<{ issueWorkspaceInvitation?: { code?: string } }>({
        jar: owner.jar,
        query: ISSUE,
        variables: {
          input: { email, role: "VIEWER", idempotencyKey: crypto.randomUUID() },
        },
      }),
      fixture.execute<{ issueWorkspaceInvitation?: { code?: string } }>({
        jar: owner.jar,
        query: ISSUE,
        variables: {
          input: {
            email: email.toLowerCase(),
            role: "VIEWER",
            idempotencyKey: crypto.randomUUID(),
          },
        },
      }),
    ]);
    expect(
      [
        left.body?.data?.issueWorkspaceInvitation?.code,
        right.body?.data?.issueWorkspaceInvitation?.code,
      ].sort(),
    ).toEqual(["APPLIED", "UNCHANGED"]);
    const rows = await fixture.database
      .select()
      .from(invitations)
      .where(
        and(
          eq(invitations.organizationId, owner.organizationId),
          eq(invitations.status, "pending"),
        ),
      );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.email).toBe("new.member@example.test");
    const intents = await fixture.database
      .select()
      .from(authEmailOutbox)
      .where(eq(authEmailOutbox.invitationId, rows[0]!.id));
    expect(intents).toHaveLength(1);
    expect(intents[0]).toMatchObject({
      kind: "workspace_invitation",
      state: "completed",
    });
    expect(intents[0]?.encryptedPayload).not.toContain(email);
    const delivered = fixture.emailSender.messages.find((message) =>
      message.subject.startsWith("Invitation to "),
    );
    const deliveredText = delivered?.text ?? "";
    expect(deliveredText).toContain(
      `/accept-invitation#id=${encodeURIComponent(rows[0]!.id)}`,
    );
    expect(deliveredText).not.toContain("/accept-invitation?id=");
  });

  it("enforces the lower-role administrator matrix with redacted failure audit", async () => {
    const owner = await fixture.createActor();
    const admin = await fixture.createWorkspaceMember(owner, "admin");
    const denied = await fixture.execute<{
      issueWorkspaceInvitation?: { code?: string };
    }>({
      jar: admin.jar,
      query: ISSUE,
      variables: {
        input: {
          email: "peer@example.test",
          role: "ADMIN",
          idempotencyKey: crypto.randomUUID(),
        },
      },
    });
    expect(denied.body?.data?.issueWorkspaceInvitation?.code).toBe("FORBIDDEN");
    expect(await fixture.database.select().from(invitations)).toHaveLength(0);
    const audits = await fixture.database
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.action, "workspace.invitation.issue"));
    expect(audits).toHaveLength(1);
    expect(audits[0]?.outcome).toBe("failure");
    expect(JSON.stringify(audits[0]?.redactedDiff)).not.toContain(
      "peer@example.test",
    );
  });

  it("applies roles immediately and removes only the affected active workspace session", async () => {
    const owner = await fixture.createActor();
    const viewer = await fixture.createWorkspaceMember(owner, "viewer");
    const updated = await fixture.execute<{
      updateWorkspaceMemberRole?: { code?: string };
    }>({
      jar: owner.jar,
      query: UPDATE,
      variables: {
        input: {
          actionId: viewer.memberId,
          role: "CONTRIBUTOR",
          idempotencyKey: crypto.randomUUID(),
        },
      },
    });
    expect(updated.body?.data?.updateWorkspaceMemberRole?.code).toBe("APPLIED");
    const viewerDirectory = await fixture.execute({
      jar: viewer.jar,
      query: DIRECTORY,
    });
    expectGraphQLError(viewerDirectory, "FORBIDDEN");
    const [membership] = await fixture.database
      .select({ role: members.role })
      .from(members)
      .where(eq(members.id, viewer.memberId));
    expect(membership?.role).toBe("contributor");

    const removed = await fixture.execute<{
      removeWorkspaceMember?: { code?: string };
    }>({
      jar: owner.jar,
      query: REMOVE,
      variables: {
        input: {
          actionId: viewer.memberId,
          idempotencyKey: crypto.randomUUID(),
        },
      },
    });
    expect(removed.body?.data?.removeWorkspaceMember?.code).toBe("APPLIED");
    expect(
      await fixture.database
        .select()
        .from(members)
        .where(eq(members.id, viewer.memberId)),
    ).toHaveLength(0);
    const active = await fixture.database
      .select({ active: sessions.activeOrganizationId })
      .from(sessions)
      .where(eq(sessions.userId, viewer.userId));
    expect(active.every((row) => row.active === null)).toBe(true);
  });

  it("cancellation suppresses a queued invitation before delivery", async () => {
    const owner = await fixture.createActor();
    const issued = await fixture.execute<{
      issueWorkspaceInvitation?: { actionId?: string; code?: string };
    }>({
      jar: owner.jar,
      query: ISSUE,
      variables: {
        input: {
          email: "cancel@example.test",
          role: "VIEWER",
          idempotencyKey: crypto.randomUUID(),
        },
      },
    });
    const actionId = issued.body?.data?.issueWorkspaceInvitation?.actionId;
    expect(actionId).toEqual(expect.any(String));
    await fixture.database
      .update(authEmailOutbox)
      .set({ state: "queued", completedAt: null, providerMessageId: null })
      .where(eq(authEmailOutbox.invitationId, actionId!));
    const canceled = await fixture.execute<{
      cancelWorkspaceInvitation?: { code?: string };
    }>({
      jar: owner.jar,
      query: CANCEL,
      variables: { input: { actionId, idempotencyKey: crypto.randomUUID() } },
    });
    expect(canceled.body?.data?.cancelWorkspaceInvitation?.code).toBe(
      "APPLIED",
    );
    const [intent] = await fixture.database
      .select({ state: authEmailOutbox.state })
      .from(authEmailOutbox)
      .where(eq(authEmailOutbox.invitationId, actionId!));
    expect(intent?.state).toBe("dead_letter");
  });

  it("rejects cancellation while a matching delivery is running", async () => {
    const owner = await fixture.createActor();
    const issued = await fixture.execute<{
      issueWorkspaceInvitation?: { actionId?: string };
    }>({
      jar: owner.jar,
      query: ISSUE,
      variables: {
        input: {
          email: "running@example.test",
          role: "VIEWER",
          idempotencyKey: crypto.randomUUID(),
        },
      },
    });
    const actionId = issued.body?.data?.issueWorkspaceInvitation?.actionId;
    expect(actionId).toEqual(expect.any(String));
    await fixture.database
      .update(authEmailOutbox)
      .set({
        state: "running",
        completedAt: null,
        leaseOwner: "worker-race",
        leaseExpiresAt: new Date(Date.now() + 60_000),
      })
      .where(eq(authEmailOutbox.invitationId, actionId!));

    const canceled = await fixture.execute<{
      cancelWorkspaceInvitation?: { code?: string; requestId?: string };
    }>({
      jar: owner.jar,
      query: CANCEL,
      variables: { input: { actionId, idempotencyKey: crypto.randomUUID() } },
    });
    expect(canceled.body?.data?.cancelWorkspaceInvitation?.code).toBe(
      "UNCHANGED",
    );
    const [invitation] = await fixture.database
      .select({ status: invitations.status })
      .from(invitations)
      .where(eq(invitations.id, actionId!));
    expect(invitation?.status).toBe("pending");
    const [intent] = await fixture.database
      .select({ state: authEmailOutbox.state })
      .from(authEmailOutbox)
      .where(eq(authEmailOutbox.invitationId, actionId!));
    expect(intent?.state).toBe("running");
    const failures = await fixture.database
      .select({
        outcome: auditEvents.outcome,
        redactedDiff: auditEvents.redactedDiff,
      })
      .from(auditEvents)
      .where(
        eq(
          auditEvents.requestId,
          canceled.body?.data?.cancelWorkspaceInvitation?.requestId ?? "",
        ),
      );
    expect(failures).toEqual([
      { outcome: "failure", redactedDiff: { changedFields: [] } },
    ]);
  });

  it("denies API keys before any administration write", async () => {
    const owner = await fixture.createActor();
    const key = await fixture.provisionKey(owner, { invitation: ["create"] });
    const denied = await fixture.execute({
      apiKey: key.key,
      query: ISSUE,
      variables: {
        input: {
          email: "key@example.test",
          role: "VIEWER",
          idempotencyKey: crypto.randomUUID(),
        },
      },
    });
    expectGraphQLError(denied, "FORBIDDEN");
    expect(await fixture.database.select().from(invitations)).toHaveLength(0);
  });

  it("binds idempotency to the canonical request and actor", async () => {
    const owner = await fixture.createActor();
    const admin = await fixture.createWorkspaceMember(owner, "admin");
    const key = crypto.randomUUID();
    const first = await fixture.execute<{
      issueWorkspaceInvitation?: { code?: string };
    }>({
      jar: owner.jar,
      query: ISSUE,
      variables: {
        input: {
          email: "idempotent@example.test",
          role: "VIEWER",
          idempotencyKey: key,
        },
      },
    });
    const replay = await fixture.execute<{
      issueWorkspaceInvitation?: { code?: string };
    }>({
      jar: owner.jar,
      query: ISSUE,
      variables: {
        input: {
          email: "idempotent@example.test",
          role: "VIEWER",
          idempotencyKey: key,
        },
      },
    });
    const mismatch = await fixture.execute<{
      issueWorkspaceInvitation?: { code?: string; requestId?: string };
    }>({
      jar: owner.jar,
      query: ISSUE,
      variables: {
        input: {
          email: "different@example.test",
          role: "VIEWER",
          idempotencyKey: key,
        },
      },
    });
    const otherActor = await fixture.execute<{
      issueWorkspaceInvitation?: { code?: string };
    }>({
      jar: admin.jar,
      query: ISSUE,
      variables: {
        input: {
          email: "other-actor@example.test",
          role: "VIEWER",
          idempotencyKey: key,
        },
      },
    });
    expect(first.body?.data?.issueWorkspaceInvitation?.code).toBe("APPLIED");
    expect(replay.body?.data?.issueWorkspaceInvitation?.code).toBe("APPLIED");
    expect(mismatch.body?.data?.issueWorkspaceInvitation?.code).toBe("INVALID");
    expect(otherActor.body?.data?.issueWorkspaceInvitation?.code).toBe(
      "APPLIED",
    );
    const mismatchRequestId =
      mismatch.body?.data?.issueWorkspaceInvitation?.requestId ?? "";
    const conflictAudits = await fixture.database
      .select({
        action: auditEvents.action,
        outcome: auditEvents.outcome,
        redactedDiff: auditEvents.redactedDiff,
      })
      .from(auditEvents)
      .where(eq(auditEvents.requestId, mismatchRequestId));
    expect(conflictAudits).toEqual([
      {
        action: "workspace.invitation.issue",
        outcome: "failure",
        redactedDiff: { changedFields: [] },
      },
    ]);
    expect(JSON.stringify(conflictAudits)).not.toContain("different@example");
  });

  it("serializes concurrent owner demotions so one owner always remains", async () => {
    const firstOwner = await fixture.createActor();
    const secondOwner = await fixture.createWorkspaceMember(
      firstOwner,
      "viewer",
    );
    await fixture.database
      .update(members)
      .set({ role: "owner" })
      .where(eq(members.id, secondOwner.memberId));
    const results = await Promise.all([
      fixture.execute<{ updateWorkspaceMemberRole?: { code?: string } }>({
        jar: firstOwner.jar,
        query: UPDATE,
        variables: {
          input: {
            actionId: secondOwner.memberId,
            role: "ADMIN",
            idempotencyKey: crypto.randomUUID(),
          },
        },
      }),
      fixture.execute<{ updateWorkspaceMemberRole?: { code?: string } }>({
        jar: secondOwner.jar,
        query: UPDATE,
        variables: {
          input: {
            actionId: firstOwner.memberId,
            role: "ADMIN",
            idempotencyKey: crypto.randomUUID(),
          },
        },
      }),
    ]);
    const codes = results.map(
      (result) =>
        result.body?.data?.updateWorkspaceMemberRole?.code ??
        result.body?.errors?.[0]?.extensions?.code,
    );
    expect(codes).toContain("APPLIED");
    const owners = await fixture.database
      .select()
      .from(members)
      .where(
        and(
          eq(members.workspaceId, firstOwner.workspaceId),
          eq(members.role, "owner"),
        ),
      );
    expect(owners).toHaveLength(1);
  });

  it.each(["invitation_created", "outbox_queued", "audit_written"] as const)(
    "rolls invitation and encrypted intent back after %s failure",
    async (failureStep) => {
      const owner = await fixture.createActor();
      const [ownerSession] = await fixture.database
        .select({ id: sessions.id })
        .from(sessions)
        .where(eq(sessions.userId, owner.userId));
      const service = createWorkspaceMemberAdministration({
        actor: {
          type: "user",
          id: owner.userId,
          memberId: owner.memberId,
          principalId: owner.principalId,
          role: "owner",
          sessionId: ownerSession!.id,
        },
        afterStep: (step) => {
          if (step === failureStep) throw new Error("injected");
        },
        database: fixture.database,
        requestId: crypto.randomUUID(),
        runtime: {
          appUrl: testAdminEnv.NEXT_PUBLIC_APP_URL,
          authSecret: testAdminEnv.AUTH_SECRET,
          emailSender: fixture.emailSender,
          encryptionKey: testAdminEnv.AUTH_ENCRYPTION_KEY,
        },
        workspaceId: owner.workspaceId,
      });
      await expect(
        service.issueInvitation(
          `rollback-${failureStep}@example.test`,
          "viewer",
          crypto.randomUUID(),
        ),
      ).rejects.toThrow("injected");
      expect(await fixture.database.select().from(invitations)).toHaveLength(0);
      expect(
        await fixture.database.select().from(authEmailOutbox),
      ).toHaveLength(0);
      expect(
        await fixture.database
          .select()
          .from(auditEvents)
          .where(eq(auditEvents.action, "workspace.invitation.issue")),
      ).toHaveLength(0);
    },
  );

  it("does not starve valid delivery behind more than two batches of invalid invitation intents", async () => {
    const owner = await fixture.createActor();
    for (let index = 0; index < 21; index += 1) {
      const invitationId = newId();
      await fixture.database.insert(invitations).values({
        id: invitationId,
        organizationId: owner.organizationId,
        email: `canceled-${index}@example.test`,
        role: "viewer",
        status: "canceled",
        expiresAt: new Date(Date.now() + 60_000),
        inviterId: owner.userId,
      });
      await enqueueAuthEmail({
        authSecret: testAdminEnv.AUTH_SECRET,
        database: fixture.database,
        encryptionKey: testAdminEnv.AUTH_ENCRYPTION_KEY,
        idempotencyMaterial: `invalid-${index}`,
        invitationId,
        kind: "workspace_invitation",
        message: {
          to: `canceled-${index}@example.test`,
          subject: "Canceled",
          text: "Canceled",
        },
      });
    }
    const validId = newId();
    await fixture.database.insert(invitations).values({
      id: validId,
      organizationId: owner.organizationId,
      email: "valid@example.test",
      role: "viewer",
      status: "pending",
      expiresAt: new Date(Date.now() + 60_000),
      inviterId: owner.userId,
    });
    await enqueueAuthEmail({
      authSecret: testAdminEnv.AUTH_SECRET,
      database: fixture.database,
      encryptionKey: testAdminEnv.AUTH_ENCRYPTION_KEY,
      idempotencyMaterial: "valid",
      invitationId: validId,
      kind: "workspace_invitation",
      message: { to: "valid@example.test", subject: "Valid", text: "Valid" },
    });
    const result = await runAuthEmailOutboxOnce({
      database: fixture.database,
      emailSender: fixture.emailSender,
      encryptionKey: testAdminEnv.AUTH_ENCRYPTION_KEY,
      limit: 5,
    });
    expect(result).toMatchObject({ claimed: 1, completed: 1 });
    expect(fixture.emailSender.messages.at(-1)?.to).toBe("valid@example.test");
  });
});
