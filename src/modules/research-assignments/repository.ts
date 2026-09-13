import { and, desc, eq, gt, isNull, lt, or, sql } from "drizzle-orm";

import {
  researchAssignmentEvents,
  researchAssignmentItems,
} from "@/db/schema/research-assignments";
import type { Database } from "@/modules/auth/bootstrap-admin";

export function createResearchAssignmentsRepository(database: Database) {
  return {
    async get(workspaceId: string, id: string, lock = false) {
      const query = database
        .select()
        .from(researchAssignmentItems)
        .where(
          and(
            eq(researchAssignmentItems.workspaceId, workspaceId),
            eq(researchAssignmentItems.id, id),
            isNull(researchAssignmentItems.deletedAt),
          ),
        )
        .limit(1);
      const [row] = lock ? await query.for("update") : await query;
      return row ?? null;
    },
    async list(
      workspaceId: string,
      input: {
        caseId?: string | null;
        investigationId?: string | null;
        teamId?: string | null;
        canReadAllScopes?: boolean;
        principalId: string;
        status?: string | null;
        queueKind?: string | null;
        first: number;
        after?: { at: Date; id: string } | null;
      },
    ) {
      return database
        .select()
        .from(researchAssignmentItems)
        .where(
          and(
            eq(researchAssignmentItems.workspaceId, workspaceId),
            isNull(researchAssignmentItems.deletedAt),
            or(
              isNull(researchAssignmentItems.caseId),
              sql`exists (
                select 1 from case_members cm
                inner join cases c on c.workspace_id = cm.workspace_id and c.id = cm.case_id
                where cm.workspace_id = ${workspaceId}::uuid
                  and cm.case_id = ${researchAssignmentItems.caseId}
                  and cm.principal_id = ${input.principalId}::uuid
                  and cm.deleted_at is null
                  and c.deleted_at is null
              )`,
              sql`exists (
                select 1 from case_team_links ctl
                inner join team_members tm
                  on tm.workspace_id = ctl.workspace_id and tm.team_id = ctl.team_id
                inner join teams t
                  on t.workspace_id = ctl.workspace_id and t.id = ctl.team_id
                where ctl.workspace_id = ${workspaceId}::uuid
                  and ctl.case_id = ${researchAssignmentItems.caseId}
                  and ctl.deleted_at is null
                  and tm.principal_id = ${input.principalId}::uuid
                  and tm.deleted_at is null
                  and t.deleted_at is null
                  and t.state = 'active'
              )`,
            ),
            input.caseId === undefined
              ? undefined
              : input.caseId === null
                ? isNull(researchAssignmentItems.caseId)
                : eq(researchAssignmentItems.caseId, input.caseId),
            input.investigationId === undefined
              ? undefined
              : input.investigationId === null
                ? isNull(researchAssignmentItems.investigationId)
                : eq(
                    researchAssignmentItems.investigationId,
                    input.investigationId,
                  ),
            input.teamId === undefined
              ? undefined
              : input.teamId === null
                ? isNull(researchAssignmentItems.teamId)
                : eq(researchAssignmentItems.teamId, input.teamId),
            input.canReadAllScopes
              ? undefined
              : or(
                  isNull(researchAssignmentItems.investigationId),
                  sql`exists (
                    select 1 from investigations i
                    where i.workspace_id = ${workspaceId}::uuid
                      and i.id = ${researchAssignmentItems.investigationId}
                      and i.deleted_at is null
                      and i.lead_principal_id = ${input.principalId}::uuid
                  )`,
                ),
            input.canReadAllScopes
              ? undefined
              : or(
                  isNull(researchAssignmentItems.teamId),
                  sql`exists (
                    select 1 from team_members tm
                    inner join teams t on t.workspace_id = tm.workspace_id and t.id = tm.team_id
                    where tm.workspace_id = ${workspaceId}::uuid
                      and tm.team_id = ${researchAssignmentItems.teamId}
                      and tm.principal_id = ${input.principalId}::uuid
                      and tm.deleted_at is null
                      and t.deleted_at is null
                      and t.state = 'active'
                  )`,
                ),
            input.status
              ? eq(researchAssignmentItems.status, input.status)
              : undefined,
            input.queueKind
              ? eq(researchAssignmentItems.queueKind, input.queueKind)
              : undefined,
            input.after
              ? or(
                  lt(researchAssignmentItems.createdAt, input.after.at),
                  and(
                    eq(researchAssignmentItems.createdAt, input.after.at),
                    lt(researchAssignmentItems.id, input.after.id),
                  ),
                )
              : undefined,
          ),
        )
        .orderBy(
          desc(researchAssignmentItems.createdAt),
          desc(researchAssignmentItems.id),
        )
        .limit(input.first);
    },
    async events(
      workspaceId: string,
      assignmentId: string,
      input: { first: number; after?: { at: Date; id: string } | null },
    ) {
      return database
        .select()
        .from(researchAssignmentEvents)
        .where(
          and(
            eq(researchAssignmentEvents.workspaceId, workspaceId),
            eq(researchAssignmentEvents.assignmentId, assignmentId),
            sql`exists (
              select 1 from research_assignment_items rai
              where rai.workspace_id = ${workspaceId}::uuid
                and rai.id = ${assignmentId}::uuid
                and rai.deleted_at is null
            )`,
            input.after
              ? or(
                  gt(researchAssignmentEvents.occurredAt, input.after.at),
                  and(
                    eq(researchAssignmentEvents.occurredAt, input.after.at),
                    gt(researchAssignmentEvents.id, input.after.id),
                  ),
                )
              : undefined,
          ),
        )
        .orderBy(
          researchAssignmentEvents.occurredAt,
          researchAssignmentEvents.id,
        )
        .limit(input.first);
    },
  };
}

export type ResearchAssignmentsRepository = ReturnType<
  typeof createResearchAssignmentsRepository
>;
