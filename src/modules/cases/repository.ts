import {
  and,
  desc,
  eq,
  isNull,
  lt,
  or,
  sql,
  type SQL,
  type SQLWrapper,
} from "drizzle-orm";
import { cases, caseMembers, caseResourceLinks } from "@/db/schema/cases";
import { caseTeamLinks, teamMembers } from "@/db/schema/teams";
import { facts } from "@/db/schema/facts";
import { people } from "@/db/schema/people";
import { relationships } from "@/db/schema/relationships";
import type { Database } from "@/modules/auth/bootstrap-admin";
import type { CaseResourceKind } from "./types";

/** Every active case link narrows visibility; no membership can grant baseline access. */
export function caseResourceVisibilitySql(
  context: { workspaceId: string; actor: { principalId: string } },
  input: { resourceKind: string; id: SQLWrapper },
): SQL {
  if (!["person", "fact", "relationship"].includes(input.resourceKind))
    return sql`true`;
  return sql`NOT EXISTS (SELECT 1 FROM ${caseResourceLinks} WHERE ${caseResourceLinks.workspaceId} = ${context.workspaceId}::uuid AND ${caseResourceLinks.resourceKind} = ${input.resourceKind} AND ${caseResourceLinks.resourceId} = ${input.id} AND ${caseResourceLinks.deletedAt} IS NULL AND NOT EXISTS (SELECT 1 FROM ${cases} WHERE ${cases.workspaceId} = ${caseResourceLinks.workspaceId} AND ${cases.id} = ${caseResourceLinks.caseId} AND ${cases.deletedAt} IS NULL AND (EXISTS (SELECT 1 FROM ${caseMembers} WHERE ${caseMembers.workspaceId} = ${caseResourceLinks.workspaceId} AND ${caseMembers.caseId} = ${caseResourceLinks.caseId} AND ${caseMembers.principalId} = ${context.actor.principalId}::uuid AND ${caseMembers.deletedAt} IS NULL) OR EXISTS (SELECT 1 FROM ${caseTeamLinks} INNER JOIN ${teamMembers} ON ${teamMembers.workspaceId} = ${caseTeamLinks.workspaceId} AND ${teamMembers.teamId} = ${caseTeamLinks.teamId} WHERE ${caseTeamLinks.workspaceId} = ${caseResourceLinks.workspaceId} AND ${caseTeamLinks.caseId} = ${caseResourceLinks.caseId} AND ${caseTeamLinks.deletedAt} IS NULL AND ${teamMembers.principalId} = ${context.actor.principalId}::uuid AND ${teamMembers.deletedAt} IS NULL))))`;
}
export function createCasesRepository(database: Database) {
  return {
    async get(workspaceId: string, id: string, principalId: string) {
      const [row] = await database
        .select({
          case: cases,
          role: sql<string>`COALESCE(${caseMembers.role}, ${teamMembers.role}, 'member')`,
        })
        .from(cases)
        .leftJoin(
          caseMembers,
          and(
            eq(cases.workspaceId, caseMembers.workspaceId),
            eq(cases.id, caseMembers.caseId),
            eq(caseMembers.principalId, principalId),
            isNull(caseMembers.deletedAt),
          ),
        )
        .leftJoin(
          caseTeamLinks,
          and(
            eq(cases.workspaceId, caseTeamLinks.workspaceId),
            eq(cases.id, caseTeamLinks.caseId),
            isNull(caseTeamLinks.deletedAt),
          ),
        )
        .leftJoin(
          teamMembers,
          and(
            eq(teamMembers.workspaceId, caseTeamLinks.workspaceId),
            eq(teamMembers.teamId, caseTeamLinks.teamId),
            eq(teamMembers.principalId, principalId),
            isNull(teamMembers.deletedAt),
          ),
        )
        .where(
          and(
            eq(cases.workspaceId, workspaceId),
            eq(cases.id, id),
            isNull(cases.deletedAt),
            or(
              sql`${caseMembers.id} IS NOT NULL`,
              sql`${teamMembers.id} IS NOT NULL`,
            ),
          ),
        )
        .limit(1);
      return row ?? null;
    },
    list(
      workspaceId: string,
      principalId: string,
      first: number,
      after?: { at: Date; id: string } | null,
    ) {
      return database
        .selectDistinct({ case: cases })
        .from(cases)
        .leftJoin(
          caseMembers,
          and(
            eq(cases.workspaceId, caseMembers.workspaceId),
            eq(cases.id, caseMembers.caseId),
            eq(caseMembers.principalId, principalId),
            isNull(caseMembers.deletedAt),
          ),
        )
        .leftJoin(
          caseTeamLinks,
          and(
            eq(cases.workspaceId, caseTeamLinks.workspaceId),
            eq(cases.id, caseTeamLinks.caseId),
            isNull(caseTeamLinks.deletedAt),
          ),
        )
        .leftJoin(
          teamMembers,
          and(
            eq(teamMembers.workspaceId, caseTeamLinks.workspaceId),
            eq(teamMembers.teamId, caseTeamLinks.teamId),
            eq(teamMembers.principalId, principalId),
            isNull(teamMembers.deletedAt),
          ),
        )
        .where(
          and(
            eq(cases.workspaceId, workspaceId),
            isNull(cases.deletedAt),
            or(
              sql`${caseMembers.id} IS NOT NULL`,
              sql`${teamMembers.id} IS NOT NULL`,
            ),
            after
              ? or(
                  lt(cases.createdAt, after.at),
                  and(eq(cases.createdAt, after.at), lt(cases.id, after.id)),
                )
              : undefined,
          ),
        )
        .orderBy(desc(cases.createdAt), desc(cases.id))
        .limit(first);
    },
    links(
      workspaceId: string,
      caseId: string,
      first: number,
      after?: { at: Date; id: string } | null,
    ) {
      return database
        .select()
        .from(caseResourceLinks)
        .where(
          and(
            eq(caseResourceLinks.workspaceId, workspaceId),
            eq(caseResourceLinks.caseId, caseId),
            isNull(caseResourceLinks.deletedAt),
            after
              ? or(
                  lt(caseResourceLinks.observedAt, after.at),
                  and(
                    eq(caseResourceLinks.observedAt, after.at),
                    lt(caseResourceLinks.id, after.id),
                  ),
                )
              : undefined,
          ),
        )
        .orderBy(desc(caseResourceLinks.observedAt), desc(caseResourceLinks.id))
        .limit(first);
    },
    async resource(workspaceId: string, kind: CaseResourceKind, id: string) {
      if (kind === "person") {
        const [row] = await database
          .select({ id: people.id, sensitivity: people.sensitivity })
          .from(people)
          .where(
            and(
              eq(people.workspaceId, workspaceId),
              eq(people.id, id),
              isNull(people.deletedAt),
            ),
          )
          .limit(1);
        return row
          ? { ...row, personIds: [row.id], fieldDefinitionId: null }
          : null;
      }
      if (kind === "fact") {
        const [row] = await database
          .select({
            id: facts.id,
            sensitivity: facts.sensitivity,
            personId: facts.personId,
            fieldDefinitionId: facts.factDefinitionId,
          })
          .from(facts)
          .where(
            and(
              eq(facts.workspaceId, workspaceId),
              eq(facts.id, id),
              isNull(facts.deletedAt),
            ),
          )
          .limit(1);
        return row ? { ...row, personIds: [row.personId] } : null;
      }
      const [row] = await database
        .select({
          id: relationships.id,
          sensitivity: relationships.sensitivity,
          source: relationships.sourcePersonId,
          target: relationships.targetPersonId,
        })
        .from(relationships)
        .where(
          and(
            eq(relationships.workspaceId, workspaceId),
            eq(relationships.id, id),
            isNull(relationships.deletedAt),
          ),
        )
        .limit(1);
      return row
        ? {
            ...row,
            personIds: [...new Set([row.source, row.target])],
            fieldDefinitionId: null,
          }
        : null;
    },
  };
}
