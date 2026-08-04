import "server-only";

import { and, eq } from "drizzle-orm";

import { newId } from "@/db/id";
import { invitations, members, users } from "@/db/schema/auth";
import { workspaces } from "@/db/schema/workspaces";
import type { Database } from "@/modules/auth/bootstrap-admin";
import { isWorkspaceRole } from "@/modules/auth/permissions";

export type InvitationAcceptanceStep =
  "invitation_locked" | "membership_created" | "invitation_accepted";

export class InvitationLifecycleError extends Error {
  override readonly name = "InvitationLifecycleError";

  constructor(
    readonly code:
      | "ALREADY_MEMBER"
      | "EXPIRED"
      | "FORBIDDEN"
      | "INVALID_ROLE"
      | "NOT_FOUND"
      | "UNAVAILABLE",
  ) {
    super("The invitation could not be accepted.");
  }
}

export async function acceptInvitationAtomically(input: {
  afterStep?: (step: InvitationAcceptanceStep) => void | Promise<void>;
  database: Database;
  invitationId: string;
  userId: string;
}): Promise<{ organizationId: string; workspaceId: string }> {
  return input.database.transaction(async (transaction) => {
    const [record] = await transaction
      .select({
        email: invitations.email,
        expiresAt: invitations.expiresAt,
        organizationId: invitations.organizationId,
        role: invitations.role,
        status: invitations.status,
        userEmail: users.email,
        userVerified: users.emailVerified,
        workspaceId: workspaces.id,
        workspaceState: workspaces.state,
        workspaceDeletedAt: workspaces.deletedAt,
      })
      .from(invitations)
      .innerJoin(users, eq(users.id, input.userId))
      .innerJoin(
        workspaces,
        eq(workspaces.organizationId, invitations.organizationId),
      )
      .where(eq(invitations.id, input.invitationId))
      .limit(1)
      .for("update");
    if (!record) throw new InvitationLifecycleError("NOT_FOUND");
    await input.afterStep?.("invitation_locked");
    if (record.workspaceState !== "active" || record.workspaceDeletedAt) {
      throw new InvitationLifecycleError("UNAVAILABLE");
    }
    if (record.status !== "pending") {
      throw new InvitationLifecycleError("UNAVAILABLE");
    }
    if (record.expiresAt.getTime() <= Date.now()) {
      throw new InvitationLifecycleError("EXPIRED");
    }
    if (
      !record.userVerified ||
      record.userEmail.trim().toLowerCase() !==
        record.email.trim().toLowerCase()
    ) {
      throw new InvitationLifecycleError("FORBIDDEN");
    }
    if (!isWorkspaceRole(record.role) || record.role === "owner") {
      throw new InvitationLifecycleError("INVALID_ROLE");
    }
    const existing = await transaction
      .select({ id: members.id })
      .from(members)
      .where(
        and(
          eq(members.organizationId, record.organizationId),
          eq(members.userId, input.userId),
        ),
      )
      .limit(1);
    if (existing.length > 0) {
      throw new InvitationLifecycleError("ALREADY_MEMBER");
    }
    await transaction.insert(members).values({
      id: newId(),
      organizationId: record.organizationId,
      userId: input.userId,
      role: record.role,
      createdAt: new Date(),
      workspaceId: record.workspaceId,
    });
    await input.afterStep?.("membership_created");
    await transaction
      .update(invitations)
      .set({ status: "accepted" })
      .where(eq(invitations.id, input.invitationId));
    await input.afterStep?.("invitation_accepted");
    return {
      organizationId: record.organizationId,
      workspaceId: record.workspaceId,
    };
  });
}
