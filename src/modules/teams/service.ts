import { and, asc, desc, eq, isNull, lt, or, sql } from "drizzle-orm";

import { newId } from "@/db/id";
import { caseTeamLinks, teamMembers, teams } from "@/db/schema/teams";
import { workspacePrincipals } from "@/db/schema/principals";
import { caseMembers, cases } from "@/db/schema/cases";
import { createGraphQLError } from "@/graphql/errors";
import { normalizePagination } from "@/graphql/limits";
import {
  createAuditService,
  type ResearchServiceContext,
} from "@/modules/audit/service";
import {
  derivePrincipalResearchIdempotency,
  runPrincipalIdempotentResearchWrite,
  withResearchWriteTransaction,
  type CanonicalRequestMaterial,
  type ResearchResponseReference,
} from "@/modules/audit/transactions";

const TEAM_ROLES = ["owner", "reviewer", "member"] as const;
type TeamRole = (typeof TEAM_ROLES)[number];
const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1_000;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function permission(context: ResearchServiceContext, key: string) {
  if (!context.permissions.has(key))
    throw createGraphQLError("FORBIDDEN", "This operation is not permitted.");
}

function normalizeName(value: string): string {
  const name = value.normalize("NFKC").trim();
  if (name.length < 1 || name.length > 160)
    throw createGraphQLError(
      "VALIDATION_FAILED",
      "A team name must be between 1 and 160 characters.",
    );
  return name;
}

function normalizeDescription(value: string | null | undefined): string | null {
  if (value == null || value.trim() === "") return null;
  const description = value.normalize("NFKC").trim();
  if (description.length > 2_000)
    throw createGraphQLError(
      "VALIDATION_FAILED",
      "A team description cannot exceed 2,000 characters.",
    );
  return description;
}

function role(value: string | null | undefined): TeamRole {
  const selected = value ?? "member";
  if (!TEAM_ROLES.includes(selected as TeamRole) || selected === "owner")
    throw createGraphQLError(
      "VALIDATION_FAILED",
      "The team member role is invalid.",
    );
  return selected as Exclude<TeamRole, "owner">;
}

function idempotency(
  context: ResearchServiceContext,
  input: {
    key: string;
    operation: string;
    material: Readonly<Record<string, CanonicalRequestMaterial>>;
  },
) {
  if (!context.idempotencyHmacKey)
    throw createGraphQLError(
      "PRECONDITION_FAILED",
      "Team mutation idempotency is not configured.",
    );
  return derivePrincipalResearchIdempotency(context, {
    expiresAt: new Date(Date.now() + IDEMPOTENCY_TTL_MS),
    idempotencyKey: input.key,
    operation: input.operation,
    requestMaterial: input.material,
    secret: context.idempotencyHmacKey,
  });
}

function referenceUuid(
  reference: ResearchResponseReference,
  key: string,
): string {
  const value = reference[key];
  if (typeof value !== "string" || !UUID.test(value))
    throw createGraphQLError(
      "PRECONDITION_FAILED",
      "The stored team mutation result is invalid.",
    );
  return value.toLowerCase();
}

function isWorkspaceManager(context: ResearchServiceContext): boolean {
  return (
    context.actor.type === "user" &&
    (context.actor.role === "owner" || context.actor.role === "admin")
  );
}

export function createTeamsService(context: ResearchServiceContext) {
  const audit = createAuditService(context);
  const principalId = context.actor.principalId;

  async function getTeamRow(teamId: string, requireMembership = true) {
    permission(context, "team:read");
    if (!UUID.test(teamId))
      throw createGraphQLError("VALIDATION_FAILED", "The team id is invalid.");
    const manager = isWorkspaceManager(context);
    const rows = await context.database
      .select({ team: teams, membership: teamMembers })
      .from(teams)
      .leftJoin(
        teamMembers,
        and(
          eq(teamMembers.workspaceId, teams.workspaceId),
          eq(teamMembers.teamId, teams.id),
          eq(teamMembers.principalId, principalId),
          isNull(teamMembers.deletedAt),
        ),
      )
      .where(
        and(
          eq(teams.workspaceId, context.workspaceId),
          eq(teams.id, teamId),
          isNull(teams.deletedAt),
          manager || !requireMembership
            ? undefined
            : sql`${teamMembers.id} IS NOT NULL`,
        ),
      )
      .limit(1);
    const row = rows[0];
    if (!row || (!manager && requireMembership && !row.membership))
      throw createGraphQLError(
        "NOT_FOUND",
        "The requested team was not found.",
      );
    return row.team;
  }

  async function requireManager(teamId: string) {
    permission(context, "team:update");
    const team = await getTeamRow(teamId, false);
    if (isWorkspaceManager(context)) return team;
    const [membership] = await context.database
      .select({ role: teamMembers.role })
      .from(teamMembers)
      .where(
        and(
          eq(teamMembers.workspaceId, context.workspaceId),
          eq(teamMembers.teamId, teamId),
          eq(teamMembers.principalId, principalId),
          isNull(teamMembers.deletedAt),
        ),
      )
      .limit(1);
    if (membership?.role !== "owner")
      throw createGraphQLError("FORBIDDEN", "Team owner approval is required.");
    return team;
  }

  async function requireCaseManager(caseId: string) {
    permission(context, "workspace:update");
    if (!UUID.test(caseId))
      throw createGraphQLError("VALIDATION_FAILED", "The case id is invalid.");
    const [caseAccess] = await context.database
      .select({ state: cases.state, role: caseMembers.role })
      .from(cases)
      .innerJoin(
        caseMembers,
        and(
          eq(caseMembers.workspaceId, cases.workspaceId),
          eq(caseMembers.caseId, cases.id),
          eq(caseMembers.principalId, principalId),
          isNull(caseMembers.deletedAt),
        ),
      )
      .where(
        and(
          eq(cases.workspaceId, context.workspaceId),
          eq(cases.id, caseId),
          isNull(cases.deletedAt),
        ),
      )
      .limit(1);
    if (
      !caseAccess ||
      ((context.actor.type !== "user" ||
        (context.actor.role !== "owner" && context.actor.role !== "admin")) &&
        caseAccess.role !== "owner")
    )
      throw createGraphQLError("FORBIDDEN", "Case owner approval is required.");
    if (caseAccess.state !== "active")
      throw createGraphQLError(
        "PRECONDITION_FAILED",
        "Only active cases can share a team.",
      );
  }

  async function requireCaseRead(caseId: string) {
    permission(context, "team:read");
    if (isWorkspaceManager(context)) {
      const [row] = await context.database
        .select({ id: cases.id })
        .from(cases)
        .where(
          and(
            eq(cases.workspaceId, context.workspaceId),
            eq(cases.id, caseId),
            isNull(cases.deletedAt),
          ),
        )
        .limit(1);
      if (!row)
        throw createGraphQLError(
          "NOT_FOUND",
          "The requested case was not found.",
        );
      return;
    }
    const [row] = await context.database
      .select({ id: cases.id })
      .from(cases)
      .innerJoin(
        caseMembers,
        and(
          eq(caseMembers.workspaceId, cases.workspaceId),
          eq(caseMembers.caseId, cases.id),
          eq(caseMembers.principalId, principalId),
          isNull(caseMembers.deletedAt),
        ),
      )
      .where(
        and(
          eq(cases.workspaceId, context.workspaceId),
          eq(cases.id, caseId),
          isNull(cases.deletedAt),
        ),
      )
      .limit(1);
    if (!row)
      throw createGraphQLError(
        "NOT_FOUND",
        "The requested case was not found.",
      );
  }

  async function replayTeam(reference: ResearchResponseReference) {
    return getTeamRow(referenceUuid(reference, "teamId"), false);
  }

  async function replayMember(
    reference: ResearchResponseReference,
    teamId: string,
  ) {
    await requireManager(teamId);
    const memberId = referenceUuid(reference, "memberId");
    const [row] = await context.database
      .select()
      .from(teamMembers)
      .where(
        and(
          eq(teamMembers.workspaceId, context.workspaceId),
          eq(teamMembers.teamId, teamId),
          eq(teamMembers.id, memberId),
        ),
      )
      .limit(1);
    if (!row)
      throw createGraphQLError(
        "NOT_FOUND",
        "The requested team member was not found.",
      );
    return row;
  }

  async function replayCaseLink(
    reference: ResearchResponseReference,
    caseId: string,
  ) {
    await requireCaseManager(caseId);
    const linkId = referenceUuid(reference, "linkId");
    const [row] = await context.database
      .select()
      .from(caseTeamLinks)
      .where(
        and(
          eq(caseTeamLinks.workspaceId, context.workspaceId),
          eq(caseTeamLinks.caseId, caseId),
          eq(caseTeamLinks.id, linkId),
        ),
      )
      .limit(1);
    if (!row)
      throw createGraphQLError(
        "NOT_FOUND",
        "The case-team link was not found.",
      );
    return row;
  }

  return {
    async getTeam(teamId: string) {
      return getTeamRow(teamId);
    },

    async listTeams(input: { first?: number | null; after?: string | null }) {
      permission(context, "team:read");
      const { first } = normalizePagination(input);
      const manager = isWorkspaceManager(context);
      let after: { at: Date; id: string } | null = null;
      if (input.after) {
        try {
          const parsed = JSON.parse(
            Buffer.from(input.after, "base64url").toString(),
          ) as { at: string; id: string };
          const at = new Date(parsed.at);
          if (Number.isNaN(at.getTime()) || !UUID.test(parsed.id))
            throw new Error();
          after = { at, id: parsed.id };
        } catch {
          throw createGraphQLError(
            "VALIDATION_FAILED",
            "The cursor is invalid.",
          );
        }
      }
      const rows = await context.database
        .select({ team: teams })
        .from(teams)
        .leftJoin(
          teamMembers,
          and(
            eq(teamMembers.workspaceId, teams.workspaceId),
            eq(teamMembers.teamId, teams.id),
            eq(teamMembers.principalId, principalId),
            isNull(teamMembers.deletedAt),
          ),
        )
        .where(
          and(
            eq(teams.workspaceId, context.workspaceId),
            isNull(teams.deletedAt),
            manager ? undefined : sql`${teamMembers.id} IS NOT NULL`,
            after
              ? or(
                  lt(teams.createdAt, after.at),
                  and(eq(teams.createdAt, after.at), lt(teams.id, after.id)),
                )
              : undefined,
          ),
        )
        .orderBy(desc(teams.createdAt), desc(teams.id))
        .limit(first + 1);
      const pageRows = rows.slice(0, first).map((row) => row.team);
      const last = pageRows.at(-1);
      return {
        nodes: pageRows,
        pageInfo: {
          hasNextPage: rows.length > first,
          endCursor: last
            ? Buffer.from(
                JSON.stringify({
                  at: last.createdAt.toISOString(),
                  id: last.id,
                }),
              ).toString("base64url")
            : null,
        },
      };
    },

    async members(input: {
      teamId: string;
      first?: number | null;
      after?: string | null;
    }) {
      await getTeamRow(input.teamId);
      const { first } = normalizePagination(input);
      const rows = await context.database
        .select()
        .from(teamMembers)
        .where(
          and(
            eq(teamMembers.workspaceId, context.workspaceId),
            eq(teamMembers.teamId, input.teamId),
            isNull(teamMembers.deletedAt),
          ),
        )
        .orderBy(asc(teamMembers.createdAt), asc(teamMembers.id))
        .limit(first + 1);
      return {
        nodes: rows.slice(0, first),
        pageInfo: { hasNextPage: rows.length > first, endCursor: null },
      };
    },

    async createTeam(input: {
      name: string;
      description?: string | null;
      idempotencyKey?: string | null;
    }) {
      permission(context, "team:create");
      const normalized = {
        name: normalizeName(input.name),
        description: normalizeDescription(input.description),
      };
      if (input.idempotencyKey != null) {
        const executed = await runPrincipalIdempotentResearchWrite(
          context,
          idempotency(context, {
            key: input.idempotencyKey,
            operation: "team.create.graphql",
            material: normalized,
          }),
          ["team:create"],
          async (scopedContext): Promise<ResearchResponseReference> => {
            const row = await createTeamsService(scopedContext).createTeam({
              ...input,
              ...normalized,
              idempotencyKey: null,
            });
            return { teamId: row.id };
          },
        );
        return replayTeam(executed.responseReference);
      }
      return withResearchWriteTransaction(context, async (database) => {
        const [row] = await database
          .insert(teams)
          .values({
            id: newId(),
            workspaceId: context.workspaceId,
            ...normalized,
            createdBy: principalId,
            updatedBy: principalId,
          })
          .returning();
        if (!row) throw new Error("Team insert failed");
        await database.insert(teamMembers).values({
          id: newId(),
          workspaceId: context.workspaceId,
          teamId: row.id,
          principalId,
          role: "owner",
          createdBy: principalId,
          updatedBy: principalId,
        });
        await audit.write(database, {
          action: "team.create",
          resourceKind: "team",
          resourceId: row.id,
          changedFields: ["name", "description", "members"],
        });
        return row;
      });
    },

    async addMember(input: {
      teamId: string;
      principalId: string;
      role?: string | null;
      idempotencyKey?: string | null;
    }) {
      await requireManager(input.teamId);
      if (!UUID.test(input.principalId))
        throw createGraphQLError(
          "VALIDATION_FAILED",
          "The principal id is invalid.",
        );
      const selectedRole = role(input.role);
      if (input.idempotencyKey != null) {
        const executed = await runPrincipalIdempotentResearchWrite(
          context,
          idempotency(context, {
            key: input.idempotencyKey,
            operation: "team.member.add.graphql",
            material: {
              teamId: input.teamId,
              principalId: input.principalId,
              role: selectedRole,
            },
          }),
          ["team:update"],
          async (scopedContext): Promise<ResearchResponseReference> => {
            const row = await createTeamsService(scopedContext).addMember({
              ...input,
              role: selectedRole,
              idempotencyKey: null,
            });
            return { teamId: input.teamId, memberId: row.id };
          },
        );
        return replayMember(executed.responseReference, input.teamId);
      }
      return withResearchWriteTransaction(context, async (database) => {
        const [principal] = await database
          .select({ id: workspacePrincipals.id })
          .from(workspacePrincipals)
          .where(
            and(
              eq(workspacePrincipals.workspaceId, context.workspaceId),
              eq(workspacePrincipals.id, input.principalId),
            ),
          )
          .limit(1);
        if (!principal)
          throw createGraphQLError(
            "NOT_FOUND",
            "The requested principal was not found.",
          );
        const [existing] = await database
          .select()
          .from(teamMembers)
          .where(
            and(
              eq(teamMembers.workspaceId, context.workspaceId),
              eq(teamMembers.teamId, input.teamId),
              eq(teamMembers.principalId, input.principalId),
            ),
          )
          .limit(1);
        const row = existing
          ? (
              await database
                .update(teamMembers)
                .set({
                  role: selectedRole,
                  deletedAt: null,
                  deletedBy: null,
                  version: sql`${teamMembers.version} + 1`,
                  updatedAt: new Date(),
                  updatedBy: principalId,
                })
                .where(eq(teamMembers.id, existing.id))
                .returning()
            )[0]
          : (
              await database
                .insert(teamMembers)
                .values({
                  id: newId(),
                  workspaceId: context.workspaceId,
                  teamId: input.teamId,
                  principalId: input.principalId,
                  role: selectedRole,
                  createdBy: principalId,
                  updatedBy: principalId,
                })
                .returning()
            )[0];
        if (!row) throw new Error("Team member insert failed");
        await audit.write(database, {
          action: "team.member.add",
          resourceKind: "team",
          resourceId: input.teamId,
          changedFields: ["members"],
        });
        return row;
      });
    },

    async removeMember(input: {
      teamId: string;
      memberId: string;
      idempotencyKey?: string | null;
    }) {
      await requireManager(input.teamId);
      if (!UUID.test(input.memberId))
        throw createGraphQLError(
          "VALIDATION_FAILED",
          "The member id is invalid.",
        );
      if (input.idempotencyKey != null) {
        const executed = await runPrincipalIdempotentResearchWrite(
          context,
          idempotency(context, {
            key: input.idempotencyKey,
            operation: "team.member.remove.graphql",
            material: { teamId: input.teamId, memberId: input.memberId },
          }),
          ["team:update"],
          async (scopedContext): Promise<ResearchResponseReference> => {
            const row = await createTeamsService(scopedContext).removeMember({
              ...input,
              idempotencyKey: null,
            });
            return { teamId: input.teamId, memberId: row.id };
          },
        );
        return replayMember(executed.responseReference, input.teamId);
      }
      return withResearchWriteTransaction(context, async (database) => {
        const [target] = await database
          .select()
          .from(teamMembers)
          .where(
            and(
              eq(teamMembers.workspaceId, context.workspaceId),
              eq(teamMembers.teamId, input.teamId),
              eq(teamMembers.id, input.memberId),
              isNull(teamMembers.deletedAt),
            ),
          )
          .limit(1);
        if (!target)
          throw createGraphQLError(
            "NOT_FOUND",
            "The requested team member was not found.",
          );
        if (target.role === "owner") {
          const [{ count }] = await database
            .select({ count: sql<number>`count(*)` })
            .from(teamMembers)
            .where(
              and(
                eq(teamMembers.workspaceId, context.workspaceId),
                eq(teamMembers.teamId, input.teamId),
                eq(teamMembers.role, "owner"),
                isNull(teamMembers.deletedAt),
              ),
            );
          if (Number(count) <= 1)
            throw createGraphQLError(
              "PRECONDITION_FAILED",
              "A team must retain at least one owner.",
            );
        }
        const [row] = await database
          .update(teamMembers)
          .set({
            deletedAt: new Date(),
            deletedBy: principalId,
            updatedAt: new Date(),
            updatedBy: principalId,
            version: sql`${teamMembers.version} + 1`,
          })
          .where(eq(teamMembers.id, input.memberId))
          .returning();
        if (!row) throw new Error("Team member removal failed");
        await audit.write(database, {
          action: "team.member.remove",
          resourceKind: "team",
          resourceId: input.teamId,
          changedFields: ["members"],
        });
        return row;
      });
    },

    async caseTeams(caseId: string) {
      await requireCaseRead(caseId);
      const rows = await context.database
        .select({ team: teams })
        .from(caseTeamLinks)
        .innerJoin(
          teams,
          and(
            eq(teams.workspaceId, caseTeamLinks.workspaceId),
            eq(teams.id, caseTeamLinks.teamId),
            isNull(teams.deletedAt),
          ),
        )
        .where(
          and(
            eq(caseTeamLinks.workspaceId, context.workspaceId),
            eq(caseTeamLinks.caseId, caseId),
            isNull(caseTeamLinks.deletedAt),
          ),
        )
        .orderBy(asc(teams.name), asc(teams.id));
      return rows.map((row) => row.team);
    },

    async linkCase(input: {
      caseId: string;
      teamId: string;
      idempotencyKey?: string | null;
    }) {
      await requireManager(input.teamId);
      await requireCaseManager(input.caseId);
      if (!UUID.test(input.teamId))
        throw createGraphQLError(
          "VALIDATION_FAILED",
          "The team id is invalid.",
        );
      if (input.idempotencyKey != null) {
        const executed = await runPrincipalIdempotentResearchWrite(
          context,
          idempotency(context, {
            key: input.idempotencyKey,
            operation: "team.case.link.graphql",
            material: { caseId: input.caseId, teamId: input.teamId },
          }),
          ["team:update", "workspace:update"],
          async (scopedContext): Promise<ResearchResponseReference> => {
            const row = await createTeamsService(scopedContext).linkCase({
              ...input,
              idempotencyKey: null,
            });
            return { caseId: input.caseId, linkId: row.id };
          },
        );
        return replayCaseLink(executed.responseReference, input.caseId);
      }
      return withResearchWriteTransaction(context, async (database) => {
        const [existing] = await database
          .select()
          .from(caseTeamLinks)
          .where(
            and(
              eq(caseTeamLinks.workspaceId, context.workspaceId),
              eq(caseTeamLinks.caseId, input.caseId),
              eq(caseTeamLinks.teamId, input.teamId),
            ),
          )
          .limit(1);
        const [row] = existing
          ? await database
              .update(caseTeamLinks)
              .set({
                deletedAt: null,
                deletedBy: null,
                updatedAt: new Date(),
                updatedBy: principalId,
                version: sql`${caseTeamLinks.version} + 1`,
              })
              .where(eq(caseTeamLinks.id, existing.id))
              .returning()
          : await database
              .insert(caseTeamLinks)
              .values({
                id: newId(),
                workspaceId: context.workspaceId,
                caseId: input.caseId,
                teamId: input.teamId,
                createdBy: principalId,
                updatedBy: principalId,
              })
              .returning();
        if (!row) throw new Error("Case-team link failed");
        await audit.write(database, {
          action: "team.case.link",
          resourceKind: "case",
          resourceId: input.caseId,
          changedFields: ["teams"],
        });
        return row;
      });
    },

    async unlinkCase(input: {
      caseId: string;
      linkId: string;
      idempotencyKey?: string | null;
    }) {
      await requireCaseManager(input.caseId);
      if (input.idempotencyKey != null) {
        const executed = await runPrincipalIdempotentResearchWrite(
          context,
          idempotency(context, {
            key: input.idempotencyKey,
            operation: "team.case.unlink.graphql",
            material: { caseId: input.caseId, linkId: input.linkId },
          }),
          ["workspace:update"],
          async (scopedContext): Promise<ResearchResponseReference> => {
            const row = await createTeamsService(scopedContext).unlinkCase({
              ...input,
              idempotencyKey: null,
            });
            return { caseId: input.caseId, linkId: row.id };
          },
        );
        return replayCaseLink(executed.responseReference, input.caseId);
      }
      return withResearchWriteTransaction(context, async (database) => {
        const [row] = await database
          .update(caseTeamLinks)
          .set({
            deletedAt: new Date(),
            deletedBy: principalId,
            updatedAt: new Date(),
            updatedBy: principalId,
            version: sql`${caseTeamLinks.version} + 1`,
          })
          .where(
            and(
              eq(caseTeamLinks.workspaceId, context.workspaceId),
              eq(caseTeamLinks.caseId, input.caseId),
              eq(caseTeamLinks.id, input.linkId),
              isNull(caseTeamLinks.deletedAt),
            ),
          )
          .returning();
        if (!row)
          throw createGraphQLError(
            "NOT_FOUND",
            "The case-team link was not found.",
          );
        await audit.write(database, {
          action: "team.case.unlink",
          resourceKind: "case",
          resourceId: input.caseId,
          changedFields: ["teams"],
        });
        return row;
      });
    },
  };
}

export type TeamsService = ReturnType<typeof createTeamsService>;
