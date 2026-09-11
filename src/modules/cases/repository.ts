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
  return sql`NOT EXISTS (SELECT 1 FROM ${caseResourceLinks} WHERE ${caseResourceLinks.workspaceId} = ${context.workspaceId}::uuid AND ${caseResourceLinks.resourceKind} = ${input.resourceKind} AND ${caseResourceLinks.resourceId} = ${input.id} AND ${caseResourceLinks.deletedAt} IS NULL AND NOT EXISTS (SELECT 1 FROM ${caseMembers} INNER JOIN ${cases} ON ${cases.workspaceId} = ${caseMembers.workspaceId} AND ${cases.id} = ${caseMembers.caseId} WHERE ${caseMembers.workspaceId} = ${caseResourceLinks.workspaceId} AND ${caseMembers.caseId} = ${caseResourceLinks.caseId} AND ${caseMembers.principalId} = ${context.actor.principalId}::uuid AND ${caseMembers.deletedAt} IS NULL AND ${cases.deletedAt} IS NULL))`;
}
export function createCasesRepository(database: Database) {
  return {
    async get(workspaceId: string, id: string, principalId: string) {
      const [row] = await database
        .select({ case: cases, role: caseMembers.role })
        .from(cases)
        .innerJoin(
          caseMembers,
          and(
            eq(cases.workspaceId, caseMembers.workspaceId),
            eq(cases.id, caseMembers.caseId),
          ),
        )
        .where(
          and(
            eq(cases.workspaceId, workspaceId),
            eq(cases.id, id),
            eq(caseMembers.principalId, principalId),
            isNull(cases.deletedAt),
            isNull(caseMembers.deletedAt),
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
        .select({ case: cases })
        .from(cases)
        .innerJoin(
          caseMembers,
          and(
            eq(cases.workspaceId, caseMembers.workspaceId),
            eq(cases.id, caseMembers.caseId),
          ),
        )
        .where(
          and(
            eq(cases.workspaceId, workspaceId),
            eq(caseMembers.principalId, principalId),
            isNull(cases.deletedAt),
            isNull(caseMembers.deletedAt),
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
