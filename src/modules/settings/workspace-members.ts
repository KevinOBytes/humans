import "server-only";

import { createHmac } from "node:crypto";

import { and, asc, count, eq, gt, isNull, sql } from "drizzle-orm";

import { newId } from "@/db/id";
import { invitations, members, sessions, users } from "@/db/schema/auth";
import { authEmailOutbox } from "@/db/schema/auth-email-outbox";
import { auditEvents, idempotencyKeys } from "@/db/schema/operations";
import { workspaces } from "@/db/schema/workspaces";
import type { GraphQLActor } from "@/graphql/context";
import type { EmailSender } from "@/lib/email/resend";
import type { Database } from "@/modules/auth/bootstrap-admin";
import {
  enqueueAuthEmail,
  runAuthEmailOutboxOnce,
} from "@/modules/auth/email-outbox";
import {
  isWorkspaceRole,
  type WorkspaceRole,
} from "@/modules/auth/permissions";
import {
  canInviteRole,
  canManageMember,
} from "@/modules/settings/member-policy";

export type WorkspaceMemberRuntime = {
  appUrl: string;
  authSecret: string;
  emailSender: EmailSender;
  encryptionKey: string;
};

export type WorkspaceAdministrationStep =
  | "actor_authorized"
  | "audit_written"
  | "invitation_created"
  | "outbox_queued"
  | "member_updated"
  | "sessions_cleared"
  | "member_deleted";

export type SafeDirectoryMember = {
  actionId: string;
  displayName: string;
  email: string;
  joinedAt: string;
  isSelf: boolean;
  role: WorkspaceRole;
};

export type SafeDirectoryInvitation = {
  actionId: string;
  createdAt: string;
  email: string;
  expiresAt: string;
  role: Exclude<WorkspaceRole, "owner">;
  status: "expired" | "pending";
};

export type WorkspaceDirectory = {
  actorRole: WorkspaceRole;
  invitations: readonly SafeDirectoryInvitation[];
  members: {
    hasMore: boolean;
    hasPrevious: boolean;
    limit: number;
    nodes: readonly SafeDirectoryMember[];
    offset: number;
    total: number;
  };
};

export type AdministrationMutationResult = {
  actionId: string | null;
  code: "APPLIED" | "FORBIDDEN" | "INVALID" | "UNCHANGED";
  requestId: string;
};

export class WorkspaceAdministrationAccessError extends Error {
  override readonly name = "WorkspaceAdministrationAccessError";
}

type TransactionDatabase = Parameters<
  Parameters<Database["transaction"]>[0]
>[0];

const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,255}$/u;
const IDEMPOTENCY =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const ACTION_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const INVITATION_LIFETIME_MS = 48 * 60 * 60_000;
const IDEMPOTENCY_LIFETIME_MS = 24 * 60 * 60_000;

function digest(secret: string, value: string): string {
  return createHmac("sha256", secret).update(value, "utf8").digest("hex");
}

export function normalizeInvitationEmail(value: string): string | null {
  const normalized = value.normalize("NFKC").trim().toLowerCase();
  return EMAIL.test(normalized) && Buffer.byteLength(normalized, "utf8") <= 320
    ? normalized
    : null;
}

function validMutationKey(value: string): boolean {
  return IDEMPOTENCY.test(value);
}

function stableMaterial(value: Record<string, unknown>): string {
  return JSON.stringify(
    Object.fromEntries(
      Object.entries(value).sort(([a], [b]) => a.localeCompare(b)),
    ),
  );
}

async function workspaceLock(
  transaction: TransactionDatabase,
  workspaceId: string,
) {
  await transaction.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${workspaceId}, 0))`,
  );
}

async function administrativeActor(input: {
  actor: GraphQLActor;
  transaction: TransactionDatabase;
  workspaceId: string;
}): Promise<{
  organizationId: string;
  role: "admin" | "owner";
  userId: string;
} | null> {
  if (input.actor.type !== "user") return null;
  await workspaceLock(input.transaction, input.workspaceId);
  const rows = await input.transaction
    .select({
      organizationId: workspaces.organizationId,
      role: members.role,
      userId: members.userId,
    })
    .from(workspaces)
    .innerJoin(
      members,
      and(
        eq(members.workspaceId, workspaces.id),
        eq(members.organizationId, workspaces.organizationId),
      ),
    )
    .where(
      and(
        eq(workspaces.id, input.workspaceId),
        eq(workspaces.state, "active"),
        isNull(workspaces.deletedAt),
        eq(members.id, input.actor.memberId),
        eq(members.userId, input.actor.id),
      ),
    )
    .limit(2)
    .for("update");
  const row = rows[0];
  return rows.length === 1 &&
    row &&
    (row.role === "owner" || row.role === "admin")
    ? {
        organizationId: row.organizationId,
        role: row.role as "admin" | "owner",
        userId: row.userId,
      }
    : null;
}

async function writeAudit(input: {
  action: string;
  actor: Extract<GraphQLActor, { type: "user" }>;
  changedFields: readonly string[];
  outcome: "failure" | "success";
  requestId: string;
  resourceId?: string | null;
  transaction: TransactionDatabase;
  workspaceId: string;
}) {
  await input.transaction.insert(auditEvents).values({
    id: newId(),
    workspaceId: input.workspaceId,
    actorUserId: input.actor.id,
    sessionId: input.actor.sessionId,
    action: input.action,
    resourceKind: "workspace_membership",
    resourceId: input.resourceId ?? null,
    requestId: input.requestId,
    redactedDiff: { changedFields: [...input.changedFields] },
    outcome: input.outcome,
  });
}

function parseStoredResult(
  value: unknown,
): AdministrationMutationResult | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  return (row.actionId === null ||
    (typeof row.actionId === "string" && ACTION_ID.test(row.actionId))) &&
    (row.code === "APPLIED" ||
      row.code === "FORBIDDEN" ||
      row.code === "INVALID" ||
      row.code === "UNCHANGED") &&
    typeof row.requestId === "string"
    ? (row as AdministrationMutationResult)
    : null;
}

async function idempotentWrite(input: {
  actor: Extract<GraphQLActor, { type: "user" }>;
  key: string;
  secret: string;
  material: Record<string, unknown>;
  operation: string;
  requestId: string;
  run(transaction: TransactionDatabase): Promise<AdministrationMutationResult>;
  transaction: TransactionDatabase;
  workspaceId: string;
}): Promise<AdministrationMutationResult> {
  const binding = `${input.workspaceId}:${input.actor.id}:${input.operation}`;
  const keyHash = digest(input.secret, `${binding}:key:${input.key}`);
  const requestHash = `sha256:${digest(input.secret, `${binding}:request:${stableMaterial(input.material)}`)}`;
  const existing = await input.transaction
    .select({
      requestHash: idempotencyKeys.requestHash,
      responseReference: idempotencyKeys.responseReference,
      status: idempotencyKeys.status,
    })
    .from(idempotencyKeys)
    .where(
      and(
        eq(idempotencyKeys.workspaceId, input.workspaceId),
        eq(idempotencyKeys.actorId, input.actor.id),
        eq(idempotencyKeys.operation, input.operation),
        eq(idempotencyKeys.keyHash, keyHash),
        gt(idempotencyKeys.expiresAt, new Date()),
      ),
    )
    .limit(1)
    .for("update");
  const replay = existing[0];
  if (replay) {
    const parsed = parseStoredResult(replay.responseReference);
    if (
      replay.requestHash === requestHash &&
      replay.status === "completed" &&
      parsed
    ) {
      return parsed;
    }
    await writeAudit({
      action: input.operation,
      actor: input.actor,
      changedFields: [],
      outcome: "failure",
      requestId: input.requestId,
      transaction: input.transaction,
      workspaceId: input.workspaceId,
    });
    return { actionId: null, code: "INVALID", requestId: input.requestId };
  }
  const id = newId();
  await input.transaction.insert(idempotencyKeys).values({
    id,
    workspaceId: input.workspaceId,
    actorId: input.actor.id,
    operation: input.operation,
    keyHash,
    requestHash,
    expiresAt: new Date(Date.now() + IDEMPOTENCY_LIFETIME_MS),
  });
  const result = await input.run(input.transaction);
  await input.transaction
    .update(idempotencyKeys)
    .set({
      status: "completed",
      responseReference: result,
      updatedAt: new Date(),
    })
    .where(eq(idempotencyKeys.id, id));
  return result;
}

function invitationMessage(input: {
  appUrl: string;
  invitationId: string;
  workspaceName: string;
}) {
  const url = new URL("/accept-invitation", input.appUrl);
  url.hash = new URLSearchParams({ id: input.invitationId }).toString();
  const text = `You were invited to ${input.workspaceName}. Accept the invitation: ${url.toString()}`;
  return {
    subject: `Invitation to ${input.workspaceName}`,
    text,
  };
}

export function createWorkspaceMemberAdministration(input: {
  actor: GraphQLActor;
  database: Database;
  afterStep?: (step: WorkspaceAdministrationStep) => Promise<void> | void;
  requestId: string;
  runtime?: WorkspaceMemberRuntime;
  workspaceId: string;
}) {
  const runtime = input.runtime;
  async function dispatch(ids: readonly string[]) {
    if (!runtime || ids.length === 0) return;
    await runAuthEmailOutboxOnce({
      database: input.database,
      emailSender: runtime.emailSender,
      encryptionKey: runtime.encryptionKey,
      ids,
    });
  }

  async function mutate(options: {
    action: string;
    key: string;
    material: Record<string, unknown>;
    operation: string;
    run(
      transaction: TransactionDatabase,
      actor: {
        organizationId: string;
        role: "admin" | "owner";
        userId: string;
      },
      queuedIds: string[],
    ): Promise<AdministrationMutationResult>;
  }): Promise<AdministrationMutationResult> {
    if (
      input.actor.type !== "user" ||
      !runtime ||
      !validMutationKey(options.key)
    ) {
      return {
        actionId: null,
        code: "INVALID",
        requestId: input.requestId,
      } as const;
    }
    const sessionActor = input.actor;
    const queuedIds: string[] = [];
    const result = await input.database.transaction(async (transaction) => {
      const actor = await administrativeActor({
        actor: sessionActor,
        transaction,
        workspaceId: input.workspaceId,
      });
      if (!actor) {
        return {
          actionId: null,
          code: "FORBIDDEN",
          requestId: input.requestId,
        } as const;
      }
      await input.afterStep?.("actor_authorized");
      return idempotentWrite({
        actor: sessionActor,
        key: options.key,
        material: options.material,
        operation: options.operation,
        requestId: input.requestId,
        secret: runtime.authSecret,
        transaction,
        workspaceId: input.workspaceId,
        run: (tx) => options.run(tx, actor, queuedIds),
      });
    });
    await dispatch(queuedIds);
    return result;
  }

  return {
    async directory(offset = 0): Promise<WorkspaceDirectory> {
      const actorMemberId =
        input.actor.type === "user" ? input.actor.memberId : null;
      const boundedOffset =
        Number.isSafeInteger(offset) && offset >= 0 && offset <= 10_000
          ? offset
          : 0;
      return input.database.transaction(async (transaction) => {
        const actor = await administrativeActor({
          actor: input.actor,
          transaction,
          workspaceId: input.workspaceId,
        });
        if (!actor) throw new WorkspaceAdministrationAccessError();
        const limit = 100;
        const [memberRows, totals, invitationRows] = await Promise.all([
          transaction
            .select({
              actionId: members.id,
              displayName: users.name,
              email: users.email,
              joinedAt: members.createdAt,
              role: members.role,
            })
            .from(members)
            .innerJoin(users, eq(users.id, members.userId))
            .where(eq(members.workspaceId, input.workspaceId))
            .orderBy(asc(members.createdAt), asc(members.id))
            .limit(limit)
            .offset(boundedOffset),
          transaction
            .select({ value: count() })
            .from(members)
            .where(eq(members.workspaceId, input.workspaceId)),
          transaction
            .select({
              actionId: invitations.id,
              createdAt: invitations.createdAt,
              email: invitations.email,
              expiresAt: invitations.expiresAt,
              role: invitations.role,
              status: invitations.status,
            })
            .from(invitations)
            .where(
              and(
                eq(invitations.organizationId, actor.organizationId),
                eq(invitations.status, "pending"),
              ),
            )
            .orderBy(asc(invitations.createdAt), asc(invitations.id)),
        ]);
        const safeMembers = memberRows.flatMap((row) =>
          isWorkspaceRole(row.role)
            ? [
                {
                  ...row,
                  displayName: row.displayName.trim() || row.email,
                  isSelf: row.actionId === actorMemberId,
                  joinedAt: row.joinedAt.toISOString(),
                  role: row.role,
                },
              ]
            : [],
        );
        const now = Date.now();
        const safeInvitations = invitationRows.flatMap((row) =>
          isWorkspaceRole(row.role) && row.role !== "owner"
            ? [
                {
                  actionId: row.actionId,
                  createdAt: row.createdAt.toISOString(),
                  email: row.email,
                  expiresAt: row.expiresAt.toISOString(),
                  role: row.role,
                  status:
                    row.expiresAt.getTime() <= now
                      ? ("expired" as const)
                      : ("pending" as const),
                },
              ]
            : [],
        );
        const total = totals[0]?.value ?? 0;
        return {
          actorRole: actor.role,
          invitations: safeInvitations,
          members: {
            hasMore: boundedOffset + safeMembers.length < total,
            hasPrevious: boundedOffset > 0,
            limit,
            nodes: safeMembers,
            offset: boundedOffset,
            total,
          },
        };
      });
    },

    issueInvitation(email: string, role: WorkspaceRole, key: string) {
      const normalizedEmail = normalizeInvitationEmail(email);
      return mutate({
        action: "workspace.invitation.issue",
        key,
        material: { email: normalizedEmail ?? "invalid", role },
        operation: "workspace.invitation.issue",
        run: async (transaction, actor, queuedIds) => {
          if (
            !normalizedEmail ||
            !canInviteRole(actor.role, role) ||
            !runtime
          ) {
            await writeAudit({
              action: "workspace.invitation.issue",
              actor: input.actor as Extract<GraphQLActor, { type: "user" }>,
              changedFields: [],
              outcome: "failure",
              requestId: input.requestId,
              transaction,
              workspaceId: input.workspaceId,
            });
            return {
              actionId: null,
              code: normalizedEmail ? "FORBIDDEN" : "INVALID",
              requestId: input.requestId,
            };
          }
          await transaction.execute(
            sql`select pg_advisory_xact_lock(hashtextextended(${`${input.workspaceId}:${normalizedEmail}`}, 0))`,
          );
          const existingMember = await transaction
            .select({ id: members.id })
            .from(members)
            .innerJoin(users, eq(users.id, members.userId))
            .where(
              and(
                eq(members.workspaceId, input.workspaceId),
                sql`lower(${users.email}) = ${normalizedEmail}`,
              ),
            )
            .limit(1);
          const pending = await transaction
            .select({ id: invitations.id, expiresAt: invitations.expiresAt })
            .from(invitations)
            .where(
              and(
                eq(invitations.organizationId, actor.organizationId),
                eq(invitations.email, normalizedEmail),
                eq(invitations.status, "pending"),
              ),
            )
            .limit(1)
            .for("update");
          if (
            existingMember.length > 0 ||
            (pending[0] && pending[0].expiresAt.getTime() > Date.now())
          ) {
            await writeAudit({
              action: "workspace.invitation.issue",
              actor: input.actor as Extract<GraphQLActor, { type: "user" }>,
              changedFields: [],
              outcome: "success",
              requestId: input.requestId,
              transaction,
              workspaceId: input.workspaceId,
            });
            return {
              actionId: null,
              code: "UNCHANGED",
              requestId: input.requestId,
            };
          }
          if (pending[0]) {
            await transaction
              .update(invitations)
              .set({ status: "canceled" })
              .where(eq(invitations.id, pending[0].id));
            await transaction
              .update(authEmailOutbox)
              .set({
                state: "dead_letter",
                errorCode: "invitation_replaced",
                updatedAt: new Date(),
              })
              .where(
                and(
                  eq(authEmailOutbox.invitationId, pending[0].id),
                  eq(authEmailOutbox.state, "queued"),
                ),
              );
          }
          const workspace = await transaction
            .select({ name: workspaces.name })
            .from(workspaces)
            .where(eq(workspaces.id, input.workspaceId))
            .limit(1);
          const invitationId = newId();
          await transaction.insert(invitations).values({
            id: invitationId,
            organizationId: actor.organizationId,
            email: normalizedEmail,
            role,
            status: "pending",
            expiresAt: new Date(Date.now() + INVITATION_LIFETIME_MS),
            inviterId: actor.userId,
          });
          await input.afterStep?.("invitation_created");
          const message = invitationMessage({
            appUrl: runtime.appUrl,
            invitationId,
            workspaceName: workspace[0]?.name ?? "Humans",
          });
          const outboxId = await enqueueAuthEmail({
            authSecret: runtime.authSecret,
            database: transaction as unknown as Database,
            encryptionKey: runtime.encryptionKey,
            idempotencyMaterial: `workspace-invitation:${invitationId}`,
            kind: "workspace_invitation",
            invitationId,
            message: { ...message, to: normalizedEmail },
          });
          queuedIds.push(outboxId);
          await input.afterStep?.("outbox_queued");
          await writeAudit({
            action: "workspace.invitation.issue",
            actor: input.actor as Extract<GraphQLActor, { type: "user" }>,
            changedFields: ["role", "status"],
            outcome: "success",
            requestId: input.requestId,
            resourceId: invitationId,
            transaction,
            workspaceId: input.workspaceId,
          });
          await input.afterStep?.("audit_written");
          return {
            actionId: invitationId,
            code: "APPLIED",
            requestId: input.requestId,
          };
        },
      });
    },

    resendInvitation(actionId: string, key: string) {
      return mutate({
        action: "workspace.invitation.resend",
        key,
        material: { actionId },
        operation: "workspace.invitation.resend",
        run: async (transaction, actor, queuedIds) => {
          const rows = ACTION_ID.test(actionId)
            ? await transaction
                .select({
                  email: invitations.email,
                  expiresAt: invitations.expiresAt,
                  role: invitations.role,
                  status: invitations.status,
                  workspaceName: workspaces.name,
                })
                .from(invitations)
                .innerJoin(
                  workspaces,
                  eq(workspaces.organizationId, invitations.organizationId),
                )
                .where(
                  and(
                    eq(invitations.id, actionId),
                    eq(invitations.organizationId, actor.organizationId),
                  ),
                )
                .limit(1)
                .for("update")
            : [];
          const invitation = rows[0];
          if (
            !invitation ||
            invitation.status !== "pending" ||
            invitation.expiresAt.getTime() <= Date.now() ||
            !isWorkspaceRole(invitation.role) ||
            !canInviteRole(actor.role, invitation.role) ||
            !runtime
          ) {
            await writeAudit({
              action: "workspace.invitation.resend",
              actor: input.actor as Extract<GraphQLActor, { type: "user" }>,
              changedFields: [],
              outcome: "failure",
              requestId: input.requestId,
              transaction,
              workspaceId: input.workspaceId,
            });
            return {
              actionId: null,
              code: "UNCHANGED",
              requestId: input.requestId,
            };
          }
          const message = invitationMessage({
            appUrl: runtime.appUrl,
            invitationId: actionId,
            workspaceName: invitation.workspaceName,
          });
          const outboxId = await enqueueAuthEmail({
            authSecret: runtime.authSecret,
            database: transaction as unknown as Database,
            encryptionKey: runtime.encryptionKey,
            idempotencyMaterial: `workspace-invitation-resend:${actionId}:${key}`,
            kind: "workspace_invitation",
            invitationId: actionId,
            message: { ...message, to: invitation.email },
          });
          queuedIds.push(outboxId);
          await writeAudit({
            action: "workspace.invitation.resend",
            actor: input.actor as Extract<GraphQLActor, { type: "user" }>,
            changedFields: ["deliveryIntent"],
            outcome: "success",
            requestId: input.requestId,
            resourceId: actionId,
            transaction,
            workspaceId: input.workspaceId,
          });
          return { actionId, code: "APPLIED", requestId: input.requestId };
        },
      });
    },

    cancelInvitation(actionId: string, key: string) {
      return mutate({
        action: "workspace.invitation.cancel",
        key,
        material: { actionId },
        operation: "workspace.invitation.cancel",
        run: async (transaction, actor) => {
          const rows = ACTION_ID.test(actionId)
            ? await transaction
                .select({
                  expiresAt: invitations.expiresAt,
                  role: invitations.role,
                  status: invitations.status,
                })
                .from(invitations)
                .where(
                  and(
                    eq(invitations.id, actionId),
                    eq(invitations.organizationId, actor.organizationId),
                  ),
                )
                .limit(1)
                .for("update")
            : [];
          const invitation = rows[0];
          if (
            !invitation ||
            invitation.status !== "pending" ||
            invitation.expiresAt.getTime() <= Date.now() ||
            !isWorkspaceRole(invitation.role) ||
            !canInviteRole(actor.role, invitation.role)
          ) {
            await writeAudit({
              action: "workspace.invitation.cancel",
              actor: input.actor as Extract<GraphQLActor, { type: "user" }>,
              changedFields: [],
              outcome: "failure",
              requestId: input.requestId,
              transaction,
              workspaceId: input.workspaceId,
            });
            return {
              actionId: null,
              code: "UNCHANGED",
              requestId: input.requestId,
            };
          }
          const deliveryRows = await transaction
            .select({ state: authEmailOutbox.state })
            .from(authEmailOutbox)
            .where(eq(authEmailOutbox.invitationId, actionId))
            .for("update");
          if (deliveryRows.some((row) => row.state === "running")) {
            await writeAudit({
              action: "workspace.invitation.cancel",
              actor: input.actor as Extract<GraphQLActor, { type: "user" }>,
              changedFields: [],
              outcome: "failure",
              requestId: input.requestId,
              transaction,
              workspaceId: input.workspaceId,
            });
            return {
              actionId: null,
              code: "UNCHANGED",
              requestId: input.requestId,
            };
          }
          await transaction
            .update(invitations)
            .set({ status: "canceled" })
            .where(eq(invitations.id, actionId));
          await transaction
            .update(authEmailOutbox)
            .set({
              state: "dead_letter",
              errorCode: "invitation_canceled",
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(authEmailOutbox.invitationId, actionId),
                eq(authEmailOutbox.state, "queued"),
              ),
            );
          await writeAudit({
            action: "workspace.invitation.cancel",
            actor: input.actor as Extract<GraphQLActor, { type: "user" }>,
            changedFields: ["status"],
            outcome: "success",
            requestId: input.requestId,
            resourceId: actionId,
            transaction,
            workspaceId: input.workspaceId,
          });
          return { actionId, code: "APPLIED", requestId: input.requestId };
        },
      });
    },

    updateMemberRole(actionId: string, nextRole: WorkspaceRole, key: string) {
      return mutate({
        action: "workspace.member.role.update",
        key,
        material: { actionId, nextRole },
        operation: "workspace.member.role.update",
        run: async (transaction, actor) => {
          const rows = ACTION_ID.test(actionId)
            ? await transaction
                .select({ role: members.role, userId: members.userId })
                .from(members)
                .where(
                  and(
                    eq(members.id, actionId),
                    eq(members.workspaceId, input.workspaceId),
                  ),
                )
                .limit(1)
                .for("update")
            : [];
          const target = rows[0];
          const allowed =
            target &&
            isWorkspaceRole(target.role) &&
            isWorkspaceRole(nextRole) &&
            canManageMember({
              actorRole: actor.role,
              actorUserId: actor.userId,
              targetRole: target.role,
              targetUserId: target.userId,
              nextRole,
            });
          let lastOwner = false;
          if (allowed && target.role === "owner") {
            const owners = await transaction
              .select({ value: count() })
              .from(members)
              .where(
                and(
                  eq(members.workspaceId, input.workspaceId),
                  eq(members.role, "owner"),
                ),
              );
            lastOwner = (owners[0]?.value ?? 0) <= 1;
          }
          if (!allowed || lastOwner || nextRole === target?.role) {
            await writeAudit({
              action: "workspace.member.role.update",
              actor: input.actor as Extract<GraphQLActor, { type: "user" }>,
              changedFields: [],
              outcome: "failure",
              requestId: input.requestId,
              transaction,
              workspaceId: input.workspaceId,
            });
            return {
              actionId: null,
              code:
                allowed && nextRole === target?.role
                  ? "UNCHANGED"
                  : "FORBIDDEN",
              requestId: input.requestId,
            };
          }
          await transaction
            .update(members)
            .set({ role: nextRole })
            .where(eq(members.id, actionId));
          await input.afterStep?.("member_updated");
          await writeAudit({
            action: "workspace.member.role.update",
            actor: input.actor as Extract<GraphQLActor, { type: "user" }>,
            changedFields: ["role"],
            outcome: "success",
            requestId: input.requestId,
            resourceId: actionId,
            transaction,
            workspaceId: input.workspaceId,
          });
          await input.afterStep?.("audit_written");
          return { actionId, code: "APPLIED", requestId: input.requestId };
        },
      });
    },

    removeMember(actionId: string, key: string) {
      return mutate({
        action: "workspace.member.remove",
        key,
        material: { actionId },
        operation: "workspace.member.remove",
        run: async (transaction, actor) => {
          const rows = ACTION_ID.test(actionId)
            ? await transaction
                .select({ role: members.role, userId: members.userId })
                .from(members)
                .where(
                  and(
                    eq(members.id, actionId),
                    eq(members.workspaceId, input.workspaceId),
                  ),
                )
                .limit(1)
                .for("update")
            : [];
          const target = rows[0];
          const allowed =
            target &&
            isWorkspaceRole(target.role) &&
            canManageMember({
              actorRole: actor.role,
              actorUserId: actor.userId,
              targetRole: target.role,
              targetUserId: target.userId,
            });
          let lastOwner = false;
          if (allowed && target.role === "owner") {
            const owners = await transaction
              .select({ value: count() })
              .from(members)
              .where(
                and(
                  eq(members.workspaceId, input.workspaceId),
                  eq(members.role, "owner"),
                ),
              );
            lastOwner = (owners[0]?.value ?? 0) <= 1;
          }
          if (!allowed || lastOwner || !target) {
            await writeAudit({
              action: "workspace.member.remove",
              actor: input.actor as Extract<GraphQLActor, { type: "user" }>,
              changedFields: [],
              outcome: "failure",
              requestId: input.requestId,
              transaction,
              workspaceId: input.workspaceId,
            });
            return {
              actionId: null,
              code: "FORBIDDEN",
              requestId: input.requestId,
            };
          }
          await writeAudit({
            action: "workspace.member.remove",
            actor: input.actor as Extract<GraphQLActor, { type: "user" }>,
            changedFields: ["membership", "activeWorkspace"],
            outcome: "success",
            requestId: input.requestId,
            resourceId: actionId,
            transaction,
            workspaceId: input.workspaceId,
          });
          await transaction
            .update(sessions)
            .set({ activeOrganizationId: null })
            .where(
              and(
                eq(sessions.userId, target.userId),
                eq(sessions.activeOrganizationId, actor.organizationId),
              ),
            );
          await input.afterStep?.("sessions_cleared");
          await transaction.delete(members).where(eq(members.id, actionId));
          await input.afterStep?.("member_deleted");
          return { actionId, code: "APPLIED", requestId: input.requestId };
        },
      });
    },
  };
}

export type WorkspaceMemberAdministration = ReturnType<
  typeof createWorkspaceMemberAdministration
>;
