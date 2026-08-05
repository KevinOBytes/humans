// @vitest-environment node

import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  CancelWorkspaceInvitationDocument,
  IssueWorkspaceInvitationDocument,
  UpdateWorkspaceMemberRoleDocument,
} from "@/graphql/generated/graphql";
import { authEmailOutbox } from "@/db/schema/auth-email-outbox";
import { invitations, members, sessions } from "@/db/schema/auth";
import { auditEvents } from "@/db/schema/operations";
import { createInvitationAcceptanceHandler } from "@/app/api/account/invitations/accept/route";
import { createInvitationHandoffHandlers } from "@/app/api/account/invitations/handoff/route";
import { acceptInvitationAtomically } from "@/modules/auth/invitation-lifecycle";
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
const REMOVE = /* GraphQL */ `
  mutation Remove($input: WorkspaceInvitationActionInput!) {
    removeWorkspaceMember(input: $input) {
      actionId
      code
      requestId
    }
  }
`;
const appOrigin = new URL(testAdminEnv.NEXT_PUBLIC_APP_URL).origin;

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
        operationName: "IssueWorkspaceInvitation",
        query: IssueWorkspaceInvitationDocument,
        variables: {
          input: { email, role: "VIEWER", idempotencyKey: crypto.randomUUID() },
        },
      }),
      fixture.execute<{ issueWorkspaceInvitation?: { code?: string } }>({
        jar: owner.jar,
        operationName: "IssueWorkspaceInvitation",
        query: IssueWorkspaceInvitationDocument,
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
      operationName: "IssueWorkspaceInvitation",
      query: IssueWorkspaceInvitationDocument,
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

  it("hands a recipient invitation through the opaque handoff into atomic acceptance", async () => {
    const owner = await fixture.createActor();
    const recipientEmail = "handoff-recipient@example.test";
    const recipient = await fixture.createUser({
      email: recipientEmail,
      username: "HandoffRecipient",
    });
    const issued = await fixture.execute<{
      issueWorkspaceInvitation?: { actionId?: string; code?: string };
    }>({
      jar: owner.jar,
      operationName: "IssueWorkspaceInvitation",
      query: IssueWorkspaceInvitationDocument,
      variables: {
        input: {
          email: recipientEmail,
          role: "VIEWER",
          idempotencyKey: crypto.randomUUID(),
        },
      },
    });
    const invitationId = issued.body?.data?.issueWorkspaceInvitation?.actionId;
    expect(issued.body?.data?.issueWorkspaceInvitation?.code).toBe("APPLIED");
    expect(invitationId).toEqual(expect.any(String));

    const handoff = createInvitationHandoffHandlers({
      encryptionKey: testAdminEnv.AUTH_ENCRYPTION_KEY,
      getSession: (headers) => fixture.runtime.api.getSession({ headers }),
      secureCookies: false,
      trustedOrigins: [appOrigin],
    });
    const establishHeaders = new Headers({
      "content-type": "application/json",
      origin: appOrigin,
    });
    recipient.jar.apply(establishHeaders);
    const established = await handoff.POST(
      new Request(`${appOrigin}/api/account/invitations/handoff`, {
        body: JSON.stringify({ invitationId }),
        headers: establishHeaders,
        method: "POST",
      }),
    );
    expect(established.status).toBe(200);
    const handoffCookie = established.headers.get("set-cookie");
    expect(handoffCookie).toContain("HttpOnly");
    expect(handoffCookie).toContain("SameSite=Strict");
    expect(handoffCookie).not.toContain(invitationId!);

    const handoffCookiePair = handoffCookie!.split(";", 1)[0]!;
    const unauthenticated = await handoff.GET(
      new Request(`${appOrigin}/api/account/invitations/handoff`, {
        headers: { cookie: handoffCookiePair },
      }),
    );
    expect(unauthenticated.status).toBe(401);

    const foreign = await fixture.createUser({
      email: "foreign-recipient@example.test",
      username: "ForeignRecipient",
    });
    const foreignHeaders = new Headers({ origin: appOrigin });
    foreign.jar.apply(foreignHeaders);
    foreignHeaders.set(
      "cookie",
      `${foreignHeaders.get("cookie")}; ${handoffCookiePair}`,
    );
    const opened = await handoff.GET(
      new Request(`${appOrigin}/api/account/invitations/handoff`, {
        headers: foreignHeaders,
      }),
    );
    expect(opened.status).toBe(200);
    await expect(opened.json()).resolves.toMatchObject({ invitationId });

    const acceptance = createInvitationAcceptanceHandler({
      database: fixture.database,
      getSession: (headers) => fixture.runtime.api.getSession({ headers }),
      trustedOrigins: [appOrigin],
    });
    const unauthenticatedAccepted = await acceptance(
      new Request(`${appOrigin}/api/account/invitations/accept`, {
        body: JSON.stringify({ invitationId }),
        headers: {
          "content-type": "application/json",
          cookie: handoffCookiePair,
          origin: appOrigin,
        },
        method: "POST",
      }),
    );
    expect(unauthenticatedAccepted.status).toBe(401);

    const foreignAccepted = await acceptance(
      new Request(`${appOrigin}/api/account/invitations/accept`, {
        body: JSON.stringify({ invitationId }),
        headers: {
          "content-type": "application/json",
          cookie: foreignHeaders.get("cookie")!,
          origin: appOrigin,
        },
        method: "POST",
      }),
    );
    expect(foreignAccepted.status).toBe(409);
    await expect(foreignAccepted.json()).resolves.toMatchObject({
      code: "INVITATION_UNAVAILABLE",
    });
    expect(
      await fixture.database
        .select({ userId: members.userId })
        .from(members)
        .where(eq(members.userId, foreign.userId)),
    ).toEqual([]);

    recipient.jar.capture(established);
    const recipientHeaders = new Headers({ origin: appOrigin });
    recipient.jar.apply(recipientHeaders);
    const accepted = await acceptance(
      new Request(`${appOrigin}/api/account/invitations/accept`, {
        body: JSON.stringify({ invitationId }),
        headers: {
          "content-type": "application/json",
          cookie: recipientHeaders.get("cookie")!,
          origin: appOrigin,
        },
        method: "POST",
      }),
    );
    expect(accepted.status).toBe(200);
    expect(accepted.headers.get("set-cookie")).toContain("Max-Age=0");
    await expect(accepted.json()).resolves.toMatchObject({
      result: {
        organizationId: owner.organizationId,
        workspaceId: owner.workspaceId,
      },
      status: true,
    });
    expect(
      await fixture.database
        .select({ role: members.role })
        .from(members)
        .where(
          and(
            eq(members.organizationId, owner.organizationId),
            eq(members.userId, recipient.userId),
          ),
        ),
    ).toEqual([{ role: "viewer" }]);
    expect(
      await fixture.database
        .select({ status: invitations.status })
        .from(invitations)
        .where(eq(invitations.id, invitationId!)),
    ).toEqual([{ status: "accepted" }]);
  });

  it("permits owners to assign admins while restricting admins to lower-role members", async () => {
    const owner = await fixture.createActor();
    const admin = await fixture.createWorkspaceMember(owner, "admin");
    const viewer = await fixture.createWorkspaceMember(owner, "viewer");
    const promoted = await fixture.execute<{
      updateWorkspaceMemberRole?: { actionId?: string | null; code?: string };
    }>({
      jar: owner.jar,
      operationName: "UpdateWorkspaceMemberRole",
      query: UpdateWorkspaceMemberRoleDocument,
      variables: {
        input: {
          actionId: viewer.memberId,
          role: "ADMIN",
          idempotencyKey: crypto.randomUUID(),
        },
      },
    });
    expect(promoted.body?.data?.updateWorkspaceMemberRole).toMatchObject({
      actionId: viewer.memberId,
      code: "APPLIED",
    });

    const lowerMember = await fixture.createWorkspaceMember(owner, "viewer");
    const managed = await fixture.execute<{
      updateWorkspaceMemberRole?: { actionId?: string | null; code?: string };
    }>({
      jar: admin.jar,
      operationName: "UpdateWorkspaceMemberRole",
      query: UpdateWorkspaceMemberRoleDocument,
      variables: {
        input: {
          actionId: lowerMember.memberId,
          role: "CONTRIBUTOR",
          idempotencyKey: crypto.randomUUID(),
        },
      },
    });
    expect(managed.body?.data?.updateWorkspaceMemberRole).toMatchObject({
      actionId: lowerMember.memberId,
      code: "APPLIED",
    });

    const blockedPromotion = await fixture.execute<{
      updateWorkspaceMemberRole?: { actionId?: string | null; code?: string };
    }>({
      jar: admin.jar,
      operationName: "UpdateWorkspaceMemberRole",
      query: UpdateWorkspaceMemberRoleDocument,
      variables: {
        input: {
          actionId: lowerMember.memberId,
          role: "ADMIN",
          idempotencyKey: crypto.randomUUID(),
        },
      },
    });
    expect(
      blockedPromotion.body?.data?.updateWorkspaceMemberRole,
    ).toMatchObject({ actionId: null, code: "FORBIDDEN" });

    const blockedOwnerMutation = await fixture.execute<{
      updateWorkspaceMemberRole?: { actionId?: string | null; code?: string };
    }>({
      jar: admin.jar,
      operationName: "UpdateWorkspaceMemberRole",
      query: UpdateWorkspaceMemberRoleDocument,
      variables: {
        input: {
          actionId: owner.memberId,
          role: "VIEWER",
          idempotencyKey: crypto.randomUUID(),
        },
      },
    });
    expect(
      blockedOwnerMutation.body?.data?.updateWorkspaceMemberRole,
    ).toMatchObject({ actionId: null, code: "FORBIDDEN" });
    expect(
      await fixture.database
        .select({ role: members.role })
        .from(members)
        .where(eq(members.id, owner.memberId)),
    ).toEqual([{ role: "owner" }]);
  });

  it("makes cancellation unchanged when locked acceptance wins the invitation race", async () => {
    const owner = await fixture.createActor();
    const recipientEmail = "acceptance-race@example.test";
    const recipient = await fixture.createUser({
      email: recipientEmail,
      username: "AcceptanceRace",
    });
    const issued = await fixture.execute<{
      issueWorkspaceInvitation?: { actionId?: string; code?: string };
    }>({
      jar: owner.jar,
      operationName: "IssueWorkspaceInvitation",
      query: IssueWorkspaceInvitationDocument,
      variables: {
        input: {
          email: recipientEmail,
          role: "VIEWER",
          idempotencyKey: crypto.randomUUID(),
        },
      },
    });
    const invitationId = issued.body?.data?.issueWorkspaceInvitation?.actionId;
    expect(invitationId).toEqual(expect.any(String));

    let releaseAcceptance!: () => void;
    let invitationLocked!: () => void;
    const release = new Promise<void>((resolve) => {
      releaseAcceptance = resolve;
    });
    const locked = new Promise<void>((resolve) => {
      invitationLocked = resolve;
    });
    const acceptance = acceptInvitationAtomically({
      afterStep: async (step) => {
        if (step !== "invitation_locked") return;
        invitationLocked();
        await release;
      },
      database: fixture.database,
      invitationId: invitationId!,
      userId: recipient.userId,
    });
    await locked;
    const cancellation = fixture.execute<{
      cancelWorkspaceInvitation?: { actionId?: string | null; code?: string };
    }>({
      jar: owner.jar,
      operationName: "CancelWorkspaceInvitation",
      query: CancelWorkspaceInvitationDocument,
      variables: {
        input: { actionId: invitationId, idempotencyKey: crypto.randomUUID() },
      },
    });
    releaseAcceptance();
    await expect(acceptance).resolves.toMatchObject({
      organizationId: owner.organizationId,
      workspaceId: owner.workspaceId,
    });
    await expect(cancellation).resolves.toMatchObject({
      body: {
        data: {
          cancelWorkspaceInvitation: { actionId: null, code: "UNCHANGED" },
        },
      },
    });
    expect(
      await fixture.database
        .select({ status: invitations.status })
        .from(invitations)
        .where(eq(invitations.id, invitationId!)),
    ).toEqual([{ status: "accepted" }]);
    expect(
      await fixture.database
        .select({ userId: members.userId })
        .from(members)
        .where(
          and(
            eq(members.organizationId, owner.organizationId),
            eq(members.userId, recipient.userId),
          ),
        ),
    ).toEqual([{ userId: recipient.userId }]);
  });

  it("applies roles immediately and removes only the affected active workspace session", async () => {
    const owner = await fixture.createActor();
    const viewer = await fixture.createWorkspaceMember(owner, "viewer");
    const updated = await fixture.execute<{
      updateWorkspaceMemberRole?: { code?: string };
    }>({
      jar: owner.jar,
      operationName: "UpdateWorkspaceMemberRole",
      query: UpdateWorkspaceMemberRoleDocument,
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
      operationName: "IssueWorkspaceInvitation",
      query: IssueWorkspaceInvitationDocument,
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
      operationName: "CancelWorkspaceInvitation",
      query: CancelWorkspaceInvitationDocument,
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
      operationName: "IssueWorkspaceInvitation",
      query: IssueWorkspaceInvitationDocument,
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
      operationName: "CancelWorkspaceInvitation",
      query: CancelWorkspaceInvitationDocument,
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
      operationName: "IssueWorkspaceInvitation",
      query: IssueWorkspaceInvitationDocument,
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
      operationName: "IssueWorkspaceInvitation",
      query: IssueWorkspaceInvitationDocument,
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
      operationName: "IssueWorkspaceInvitation",
      query: IssueWorkspaceInvitationDocument,
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
      operationName: "IssueWorkspaceInvitation",
      query: IssueWorkspaceInvitationDocument,
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
      operationName: "IssueWorkspaceInvitation",
      query: IssueWorkspaceInvitationDocument,
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
        operationName: "UpdateWorkspaceMemberRole",
        query: UpdateWorkspaceMemberRoleDocument,
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
        operationName: "UpdateWorkspaceMemberRole",
        query: UpdateWorkspaceMemberRoleDocument,
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
